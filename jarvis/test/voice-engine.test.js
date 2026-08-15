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
