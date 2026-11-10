import test from 'node:test';
import assert from 'node:assert/strict';

global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};

class FakeSpeechRecognition {
  constructor() {
    this.maxAlternatives = 1;
  }
  start() {}
  stop() {}
}

function makeWindow() {
  return {
    SpeechRecognition: FakeSpeechRecognition,
    speechSynthesis: { getVoices: () => [] }
  };
}

const { VoiceEngine } = await import('../src/voice-engine.js');

test('browser engine requests 3 alternatives from the recognizer', () => {
  global.window = makeWindow();
  const engine = new VoiceEngine({ onTranscript: () => {} });

  assert.equal(engine.recognition.maxAlternatives, 3);
});

test('browser engine passes runner-up transcripts through onTranscript.alternatives on a final result', () => {
  global.window = makeWindow();
  const transcripts = [];
  const engine = new VoiceEngine({ onTranscript: (t) => transcripts.push(t) });

  engine.recognition.onresult({
    resultIndex: 0,
    results: [
      Object.assign(
        [{ transcript: 'launch elden ring' }, { transcript: 'launch eldn ring' }, { transcript: 'launch elder ring' }],
        { isFinal: true }
      )
    ]
  });

  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].text, 'launch elden ring');
  assert.equal(transcripts[0].isFinal, true);
  assert.deepEqual(transcripts[0].alternatives, ['launch eldn ring', 'launch elder ring']);
});

test('browser engine reports an empty alternatives array when the recognizer returns only one guess', () => {
  global.window = makeWindow();
  const transcripts = [];
  const engine = new VoiceEngine({ onTranscript: (t) => transcripts.push(t) });

  engine.recognition.onresult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: 'open steam' }], { isFinal: true })
    ]
  });

  assert.deepEqual(transcripts[0].alternatives, []);
});

test('SAPI re-emit guard: a consecutive identical final is suppressed within the dup window', () => {
  global.window = makeWindow();
  const transcripts = [];
  const engine = new VoiceEngine({ onTranscript: (t) => transcripts.push(t) });

  engine._emitFinal('tell me a joke', []);
  engine._emitFinal('Tell me a joke', []);

  assert.equal(transcripts.length, 1, 'the re-emitted identical final must not dispatch again');
});

test('SAPI re-emit guard: a different final right after still dispatches', () => {
  global.window = makeWindow();
  const transcripts = [];
  const engine = new VoiceEngine({ onTranscript: (t) => transcripts.push(t) });

  engine._emitFinal('tell me a joke', []);
  engine._emitFinal('what time is it', []);

  assert.equal(transcripts.length, 2);
  assert.equal(transcripts[1].text, 'what time is it');
});

test('SAPI re-emit guard: the identical final dispatches again once the window has elapsed', () => {
  global.window = makeWindow();
  const transcripts = [];
  const engine = new VoiceEngine({ onTranscript: (t) => transcripts.push(t) });

  engine._emitFinal('tell me a joke', []);
  engine._lastFinalAt = Date.now() - engine.FINAL_DUP_WINDOW_MS - 1;
  engine._emitFinal('tell me a joke', []);

  assert.equal(transcripts.length, 2, 'a genuine later repeat must still work');
});

test('interim (non-final) results report no alternatives', () => {
  global.window = makeWindow();
  const transcripts = [];
  const engine = new VoiceEngine({ onTranscript: (t) => transcripts.push(t) });

  engine.recognition.onresult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: 'launch el' }, { transcript: 'launch elle' }], { isFinal: false })
    ]
  });

  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].isFinal, false);
  assert.deepEqual(transcripts[0].alternatives, []);
});

// --- Deepgram: sessions that never decode any audio (the "silently deaf" bug) ---

class FakeMediaRecorder {
  constructor() { this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; }
}
FakeMediaRecorder.isTypeSupported = () => true;

class FakeWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {}
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.instances = [];

function makeFakeMicStream() {
  return {
    getAudioTracks: () => [{}],
    getTracks: () => [{ stop() {} }]
  };
}

function makeDeepgramWindow(withElectronMic) {
  const win = makeWindow();
  win.MediaRecorder = FakeMediaRecorder;
  win.WebSocket = FakeWebSocket;
  win.navigator = { mediaDevices: { getUserMedia: async () => makeFakeMicStream() } };
  if (withElectronMic) {
    win.jarvisElectron = {
      mic: {
        start: () => { win.jarvisElectron.mic._started = true; },
        stop: () => {},
        onTranscript: () => {},
        onStatus: () => {}
      }
    };
  }
  return win;
}

// Drives one full "connect, receive a zero-duration Metadata message, close
// cleanly" Deepgram cycle — this is exactly the pattern Deepgram sends when
// it received bytes but could never decode any audio out of them.
async function runOneDeadDeepgramCycle(engine) {
  await engine._startDeepgram();
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  socket.onopen();
  socket.onmessage({ data: JSON.stringify({ type: 'Metadata', duration: 0, channels: 0 }) });
  socket.onclose({ code: 1000, reason: '', wasClean: true });
}

test('a Deepgram session that reports zero decoded duration does not reset the failure counter', async () => {
  global.window = makeDeepgramWindow(false);
  global.navigator.mediaDevices = global.window.navigator.mediaDevices;
  global.MediaRecorder = FakeMediaRecorder;
  global.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];

  const engine = new VoiceEngine({ onTranscript: () => {}, deepgramApiKey: 'test-key-1' });
  engine.autoRestart = true;
  engine.continuousMode = true;

  await runOneDeadDeepgramCycle(engine);

  assert.equal(engine._consecutiveErrors, 1);
});

test('repeated zero-duration Deepgram sessions fall back to the Electron mic engine when it is available', async () => {
  global.window = makeDeepgramWindow(true);
  global.navigator.mediaDevices = global.window.navigator.mediaDevices;
  global.MediaRecorder = FakeMediaRecorder;
  global.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];

  const engine = new VoiceEngine({ onTranscript: () => {}, deepgramApiKey: 'test-key-2' });
  engine.autoRestart = true;
  engine.continuousMode = true;

  for (let i = 0; i < 3; i++) {
    await runOneDeadDeepgramCycle(engine);
  }

  assert.equal(engine.engine, 'electron');
  assert.equal(global.window.jarvisElectron.mic._started, true);
});

test('repeated zero-duration Deepgram sessions surface a clear error when no fallback engine exists', async () => {
  global.window = makeDeepgramWindow(false);
  global.navigator.mediaDevices = global.window.navigator.mediaDevices;
  global.MediaRecorder = FakeMediaRecorder;
  global.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];

  const states = [];
  const engine = new VoiceEngine({
    onTranscript: () => {},
    onStateChange: (s) => states.push(s),
    deepgramApiKey: 'test-key-3'
  });
  engine.autoRestart = true;
  engine.continuousMode = true;

  for (let i = 0; i < 3; i++) {
    await runOneDeadDeepgramCycle(engine);
  }

  assert.equal(engine.engine, 'deepgram');
  assert.equal(engine.autoRestart, false);
  const lastState = states[states.length - 1];
  assert.equal(lastState.status, 'ERROR');
});

test('a Deepgram session that actually produces a transcript resets the failure counter', async () => {
  global.window = makeDeepgramWindow(false);
  global.navigator.mediaDevices = global.window.navigator.mediaDevices;
  global.MediaRecorder = FakeMediaRecorder;
  global.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];

  const transcripts = [];
  const engine = new VoiceEngine({ onTranscript: (t) => transcripts.push(t), deepgramApiKey: 'test-key-4' });
  engine.autoRestart = true;
  engine.continuousMode = true;

  await engine._startDeepgram();
  let socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  socket.onopen();
  socket.onmessage({
    data: JSON.stringify({ channel: { alternatives: [{ transcript: 'open steam' }] }, is_final: true })
  });
  assert.equal(engine._consecutiveErrors, 0);
  assert.equal(transcripts.length, 1);

  socket.onclose({ code: 1000, reason: '', wasClean: true });
  assert.equal(engine._consecutiveErrors, 0);
});

// --- Deepgram: overlapping sessions (the "says LISTENING but isn't" bug) ---

function setupDeepgram() {
  global.window = makeDeepgramWindow(false);
  global.navigator.mediaDevices = global.window.navigator.mediaDevices;
  global.MediaRecorder = FakeMediaRecorder;
  global.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  const states = [];
  const engine = new VoiceEngine({ onStateChange: (s) => states.push(s.status), deepgramApiKey: 'test-key-race' });
  engine.autoRestart = true;
  engine.continuousMode = true;
  return { engine, states };
}

test('two overlapping Deepgram starts open only one session', async () => {
  const { engine } = setupDeepgram();

  await Promise.all([engine._startDeepgram(), engine._startDeepgram()]);

  assert.equal(FakeWebSocket.instances.length, 1);
});

test('a superseded Deepgram session closing late does not tear down the live one', async () => {
  const { engine, states } = setupDeepgram();

  await engine._startDeepgram();
  const stale = FakeWebSocket.instances[0];
  stale.onopen();
  engine._stopDeepgram(); // e.g. speak() — its close event arrives later

  await engine._startDeepgram();
  const live = FakeWebSocket.instances[1];
  live.onopen();

  stale.onclose({ code: 1000, reason: '', wasClean: true });

  assert.equal(engine._deepgramSocket, live);
  assert.equal(engine._mediaRecorder.state, 'recording');
  assert.equal(engine.isListening, true);
  assert.equal(states[states.length - 1], 'LISTENING');
});

test('stopListening() while getUserMedia is pending cancels the session', async () => {
  const { engine } = setupDeepgram();

  const starting = engine._startDeepgram();
  engine.stopListening();
  await starting;

  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(engine._deepgramSocket, null);
});

test('an unexpected Deepgram drop stops showing LISTENING while it reconnects', async () => {
  const { engine, states } = setupDeepgram();

  await engine._startDeepgram();
  const socket = FakeWebSocket.instances[0];
  socket.onopen();
  socket.onmessage({ data: JSON.stringify({ type: 'Metadata', duration: 3 }) });
  socket.onclose({ code: 1011, reason: '', wasClean: false });

  assert.notEqual(states[states.length - 1], 'LISTENING');
  assert.equal(engine.isListening, false);
});

test('a superseded reply does not reopen the mic and cut off the next reply', async () => {
  global.localStorage.store.clear();
  global.window = makeWindow();
  let cancels = 0;
  const pending = [];
  global.window.speechSynthesis = {
    speaking: false,
    getVoices: () => [],
    speak(u) { this.speaking = true; pending.push(u); },
    cancel() { cancels++; this.speaking = false; }
  };
  global.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };

  const engine = new VoiceEngine({});
  engine.continuousMode = true;
  let startCalls = 0;
  engine.startListening = () => { startCalls++; return true; };

  const first = engine.speak('reply A');
  pending[0].onend(); // A finishes; its 1200ms mic guard is now armed
  window.speechSynthesis.speaking = false;
  engine.speak('reply B'); // B starts inside A's guard window
  await first; // A's guard fires while B is still speaking

  assert.equal(startCalls, 0, "A's stale guard must not restart the mic over B");
  assert.equal(cancels, 0);
});

test('a fatal mic error is reported through onLog', () => {
  global.localStorage.store.clear();
  global.window = makeWindow();

  const logs = [];
  const engine = new VoiceEngine({ onLog: (l) => logs.push(l) });
  engine.recognition.onerror({ error: 'audio-capture' });

  assert.ok(logs.some((l) => l.type === 'WARNING' && /\[MIC\]/.test(l.message)));
});

test('muted speak() still runs the SPEAKING to IDLE lifecycle with no audio', async () => {
  global.localStorage.store.clear();
  global.window = makeWindow();

  const states = [];
  const engine = new VoiceEngine({ onStateChange: (s) => states.push(s.status) });
  engine.isMuted = true;

  const pending = engine.speak('Hi');
  assert.equal(engine.isSpeaking, true, 'speaking flag drives the core animation even while muted');

  await pending; // ~1.2s silent speech + 1.2s mic guard
  assert.equal(engine.isSpeaking, false);
  assert.deepEqual(states, ['SPEAKING', 'IDLE']);
});

test('stopSpeaking() during a muted reply settles it instead of hanging', async () => {
  global.localStorage.store.clear();
  global.window = makeWindow();

  const engine = new VoiceEngine({});
  engine.isMuted = true;

  const pending = engine.speak('A reply that gets cut off');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(engine.isSpeaking, true);

  engine.stopSpeaking();
  await pending; // must resolve via the mic-guard delay, not hang forever
  assert.equal(engine.isSpeaking, false);
});

// --- ElevenLabs voice synthesis (Settings-saved key, main-process proxy) ---

const ELEVENLABS_ADAM_ID = 'pNInz6obpgDQGcFmaJgB';

function installFakeAudio() {
  const instances = [];
  global.Audio = class FakeAudio {
    constructor(src) {
      this.src = src;
      this.paused = false;
      instances.push(this);
    }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  global.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
  global.Blob = class { constructor(parts) { this.parts = parts; } };
  global.URL.createObjectURL = () => 'blob:fake';
  global.URL.revokeObjectURL = () => {};
  return instances;
}

function makeElectronWindow(impl) {
  const win = makeWindow();
  win.speechSynthesis = {
    speaking: false,
    getVoices: () => [],
    speak() {},
    cancel() { this.speaking = false; }
  };
  win.jarvisElectron = {
    synthesizeElevenlabs: (...args) => impl(...args)
  };
  win.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  return win;
}

test('a saved ElevenLabs key routes speak() through the bridge with the gender-preferred voice', async () => {
  global.localStorage.store.clear();
  global.localStorage.store.set('jarvis_elevenlabs_api_key', 'el-key');
  const audioInstances = installFakeAudio();
  let requested = null;
  global.window = makeElectronWindow((text, apiKey, voiceId) => {
    requested = { text, apiKey, voiceId };
    return Promise.resolve({ success: true, base64: 'AAAA', mime: 'audio/mpeg' });
  });

  const states = [];
  const engine = new VoiceEngine({ onStateChange: (s) => states.push(s.status) });

  const pending = engine.speak('Systems online, Sir');
  await new Promise((r) => setTimeout(r, 20)); // let the synth request land
  const audio = audioInstances[0];
  audio.onplay(); // model `play()` fires the SPEAKING state + chime
  audio.onended();

  await pending;

  assert.deepEqual(requested, { text: 'Systems online, Sir', apiKey: 'el-key', voiceId: ELEVENLABS_ADAM_ID }, 'male default voice goes through the bridge');
  assert.equal(engine.isSpeaking, false);
  assert.deepEqual(states.filter((s) => s === 'SPEAKING' || s === 'IDLE').slice(-1), ['IDLE']);
  assert.ok(states.includes('SPEAKING'), 'core animation still sees the speaking state');
});

test('an ElevenLabs failure falls back to the built-in voice without hanging', async () => {
  global.localStorage.store.clear();
  global.localStorage.store.set('jarvis_elevenlabs_api_key', 'bad-key');
  installFakeAudio();
  const spoken = [];
  let cancels = 0;
  global.window = makeElectronWindow(() => Promise.resolve({ success: false, message: 'ElevenLabs HTTP 401' }));
  global.window.speechSynthesis.speak = (u) => spoken.push(u);

  const engine = new VoiceEngine({});
  engine.continuousMode = true;
  engine.startListening = () => true;

  const pending = engine.speak('Fallback reply');
  await new Promise((r) => setTimeout(r, 20)); // let the failed request land
  assert.equal(spoken.length, 1, 'the built-in Web Speech voice picks the reply up');
  assert.equal(spoken[0].text, 'Fallback reply');

  spoken[0].onend(); // resolve the fallback lifecycle
  await pending;
  assert.equal(engine.isSpeaking, false);
  assert.equal(cancels, 0);
});

test('a saved ElevenLabs Voice ID overrides the premade catalog default', async () => {
  global.localStorage.store.clear();
  global.localStorage.store.set('jarvis_elevenlabs_api_key', 'el-key');
  global.localStorage.store.set('jarvis_elevenlabs_voice_id', 'my-custom-voice-id');
  const audioInstances = installFakeAudio();
  let requested = null;
  global.window = makeElectronWindow((text, apiKey, voiceId) => {
    requested = { text, apiKey, voiceId };
    return Promise.resolve({ success: true, base64: 'AAAA', mime: 'audio/mpeg' });
  });

  const engine = new VoiceEngine({});
  const pending = engine.speak('Using my own voice');
  await new Promise((r) => setTimeout(r, 20)); // let the synth request land
  const audio = audioInstances[0];
  audio.onplay();
  audio.onended();
  await pending;

  assert.ok(requested, 'synthesis must be requested');
  assert.equal(requested.voiceId, 'my-custom-voice-id');
  assert.equal(requested.apiKey, 'el-key');
});

test('stopSpeaking() during an ElevenLabs replay settles it instead of hanging', async () => {
  global.localStorage.store.clear();
  global.localStorage.store.set('jarvis_elevenlabs_api_key', 'el-key');
  const audioInstances = installFakeAudio();
  global.window = makeElectronWindow(() => Promise.resolve({ success: true, base64: 'AAAA', mime: 'audio/mpeg' }));

  const engine = new VoiceEngine({});
  const pending = engine.speak('Cut off mid-sentence');
  await new Promise((r) => setTimeout(r, 20));
  const audio = audioInstances[0];
  audio.onplay();
  assert.equal(engine.isSpeaking, true);

  engine.stopSpeaking(); // interrupts the ElevenLabs audio element
  await pending; // must resolve via the settle path, not hang forever
  assert.equal(engine.isSpeaking, false);
});
