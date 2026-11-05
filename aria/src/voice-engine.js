/**
 * ARIA Voice Engine
 * Handles Speech-to-Text (STT), Text-to-Speech (TTS), Web Audio FX Synthesis,
 * and visualizer frequency analyzer.
 */

import { loadSettings } from './settings.js';

export class VoiceEngine {
  static VOICE_NAMES_MALE = ["Daniel", "Oliver", "Google UK English Male", "David", "Guy", "Ryan"];
  static VOICE_NAMES_FEMALE = ["Zira", "Samantha", "Susan", "Victoria", "Google UK English Female", "Hazel", "Aria", "Jenny"];

  constructor(options = {}) {
    this.onTranscript = options.onTranscript || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onVolumeChange = options.onVolumeChange || (() => {});
    this.onSpeechMeter = options.onSpeechMeter || (() => {});
    // Surfaces mic/TTS failures in the UI terminal (Chat view + activity
    // feed). Previously these only went to console.warn, so a dead mic or a
    // rejected ElevenLabs key failed silently from the user's perspective.
    this.onLog = options.onLog || (() => {});

    this.recognition = null;
    this.isElectronMic = Boolean(typeof window !== 'undefined' && window.jarvisElectron?.mic);
    this.deepgramApiKey = options.deepgramApiKey
      || localStorage.getItem('jarvis_deepgram_api_key')
      || '';
    // Deepgram (if configured) beats both the Electron/Windows bridge and the
    // browser's native engine — better accuracy, real streaming, works the
    // same everywhere since it's plain Web APIs (getUserMedia + WebSocket).
    this.engine = this.deepgramApiKey ? 'deepgram' : (this.isElectronMic ? 'electron' : 'browser');
    this.synthesis = window.speechSynthesis;
    this.isListening = false;
    this.isSpeaking = false;
    this.isMuted = false;
    this.voice = null;
    this.audioCtx = null;
    this.voiceRate = 1.05;
    this.voicePitch = 0.95;
    this.autoRestart = true;
    this.continuousMode = false; // true while the user wants always-on wake-word listening
    this._silentRestart = false; // true only during automatic re-starts — suppresses the start chime
    this._deepgramSocket = null;
    this._mediaRecorder = null;
    this._micStream = null;
    this._dgSession = null; // token for the live Deepgram session (see _startDeepgram)
    this._speechGen = 0; // bumped per reply so superseded replies can't reopen the mic

    this._initAudioContext();
    this._initSpeechRecognition();
    this._initSpeechSynthesis();
  }

  _initAudioContext() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioCtx = new AudioContext();
      }
    } catch (e) {
      console.warn("Web Audio API not supported", e);
    }
  }

  _ensureAudioContext() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  _initSpeechSynthesis() {
    if (!this.synthesis) return;

    this.applyVoicePreference();
    if (this.synthesis.onvoiceschanged !== undefined) {
      this.synthesis.onvoiceschanged = () => this.applyVoicePreference();
    }
  }

  /**
   * Re-picks this.voice from the available speechSynthesis voices, honoring
   * the current voiceGender setting. The Web Speech API exposes no real
   * gender field, only names, so this is a best-effort heuristic like the
   * original male-only version it replaces. Safe to call any time (e.g.
   * right after a Settings change) — takes effect on the next speak() call.
   */
  applyVoicePreference() {
    if (!this.synthesis) return;
    const voices = this.synthesis.getVoices();
    if (!voices.length) return;

    const preferredNames = loadSettings().voiceGender === 'female'
      ? VoiceEngine.VOICE_NAMES_FEMALE
      : VoiceEngine.VOICE_NAMES_MALE;

    this.voice =
      voices.find(v => preferredNames.some(name => v.name.includes(name))) ||
      voices.find(v => v.name.includes("Natural") || v.name.includes("Google")) ||
      voices.find(v => v.lang.startsWith("en")) ||
      voices[0];
  }

  _initSpeechRecognition() {
    if (this.engine === 'deepgram') {
      // Deepgram is connection-based (a fresh WebSocket per listening session)
      // rather than a long-lived object to configure up front — nothing to do here.
      return;
    }

    if (this.engine === 'electron') {
      this._initElectronMic();
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("Speech Recognition API unavailable in this browser.");
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "en-US";
    this.recognition.maxAlternatives = 3;

    this.recognition.onstart = () => {
      this.isListening = true;
      // Only chime on a deliberate start (mic button, post-speech resume) —
      // NOT on the frequent silent auto-restarts Chrome triggers under
      // continuous mode (e.g. after each no-speech timeout), otherwise the
      // mic pings on a loop and drowns out the window to actually talk.
      if (!this._silentRestart) {
        this.playBeep(880, 0.1, 'sine');
      }
      this._silentRestart = false;
      this.onStateChange({ status: "LISTENING", message: "Listening for voice input..." });
    };

    this.recognition.onresult = (event) => {
      // Real speech was actually recognized — the pipeline is healthy, so the
      // consecutive-error safety net can reset.
      this._consecutiveErrors = 0;

      // Ignore transcript if ARIA is speaking or in post-speech suppression window
      if (this.isSpeaking || this.suppressMic || (this.synthesis && this.synthesis.speaking)) {
        return;
      }

      let interimTranscript = '';
      let finalTranscript = '';
      let finalAlternatives = [];

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          finalTranscript += transcript;
          for (let j = 1; j < result.length; j++) {
            if (result[j]?.transcript) finalAlternatives.push(result[j].transcript);
          }
        } else {
          interimTranscript += transcript;
        }
      }

      const currentText = finalTranscript || interimTranscript;
      if (currentText.trim()) {
        this.onTranscript({
          text: currentText,
          isFinal: Boolean(finalTranscript),
          alternatives: finalTranscript ? finalAlternatives : []
        });
      }
    };

    // Errors that will never resolve themselves by simply retrying — retrying
    // on these is exactly what produces an infinite listen->error->listen loop.
    const FATAL_MIC_ERRORS = new Set(['not-allowed', 'audio-capture', 'service-not-allowed']);

    this.recognition.onerror = (event) => {
      console.warn("Speech recognition error:", event.error);

      if (FATAL_MIC_ERRORS.has(event.error)) {
        this.autoRestart = false;
        this.continuousMode = false;
        this._fatalMicError = true;
        const messages = {
          'not-allowed': 'Microphone access denied. Allow microphone permission for this site, then click the stop (■) button to retry listening.',
          'audio-capture': 'No microphone detected. Check your audio input device, then click the stop (■) button to retry listening.',
          'service-not-allowed': 'Speech recognition service unavailable. Click the stop (■) button to retry listening.'
        };
        const fatalMsg = messages[event.error] || `Mic Error: ${event.error}`;
        this.onStateChange({ status: "ERROR", message: fatalMsg });
        this.onLog({ type: 'WARNING', message: `[MIC] ${fatalMsg}` });
        return;
      }

      // Track consecutive non-fatal errors as a safety net — if something keeps
      // failing in a way we don't otherwise recognize, stop hammering it instead
      // of looping forever.
      this._consecutiveErrors = (this._consecutiveErrors || 0) + 1;
      if (this._consecutiveErrors >= 5) {
        this.autoRestart = false;
        this.continuousMode = false;
        this.onStateChange({ status: "ERROR", message: `Microphone kept failing (${event.error}). Click the stop (■) button to retry listening.` });
        this.onLog({ type: 'WARNING', message: `[MIC] Microphone kept failing (${event.error}) — wake-word listening stopped.` });
        return;
      }

      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        this.onStateChange({ status: "ERROR", message: `Mic Error: ${event.error}` });
        this.onLog({ type: 'WARNING', message: `[MIC] Mic Error: ${event.error}` });
      }
    };

    this.recognition.onend = () => {
      this.isListening = false;
      // Do NOT restart if speaking, suppressed, or a fatal error just occurred
      if (this.autoRestart && !this.isSpeaking && !this.suppressMic && !(this.synthesis && this.synthesis.speaking)) {
        // Small delay before restarting: Chrome can throw InvalidStateError if
        // start() is called immediately after end(), and an instant restart
        // loop is what produces the rapid-fire pinging when nothing is said.
        this._silentRestart = true;
        setTimeout(() => {
          if (!this.autoRestart || this.isSpeaking || this.suppressMic || (this.synthesis && this.synthesis.speaking)) {
            return;
          }
          try {
            this.recognition.start();
          } catch (e) {
            this._silentRestart = false;
            this.onStateChange({ status: "IDLE", message: "Microphone idle" });
          }
        }, 300);
      } else {
        this.onStateChange({ status: "IDLE", message: "Microphone idle" });
      }
    };
  }

  // Electron path: the browser's SpeechRecognition API doesn't work inside
  // Electron's Chromium (no proprietary Google speech backend), so voice
  // input instead comes from a Windows Speech Recognition child process
  // (electron/speech-recognizer.ps1) relayed over IPC. This keeps the same
  // onTranscript/onStateChange contract as the browser path — nothing else
  // in the app needs to know which engine is actually running.
  _initElectronMic() {
    window.jarvisElectron.mic.onTranscript(({ text, isFinal, alternatives }) => {
      if (this.isSpeaking || this.suppressMic || (this.synthesis && this.synthesis.speaking)) return;
      if (text && text.trim()) {
        this._consecutiveErrors = 0;
        this.onTranscript({ text, isFinal: Boolean(isFinal), alternatives: alternatives || [] });
      }
    });

    window.jarvisElectron.mic.onStatus(({ status, message }) => {
      if (status === 'listening') {
        this.isListening = true;
        this.playBeep(880, 0.1, 'sine');
        this.onStateChange({ status: "LISTENING", message: message || "Listening for voice input..." });
      } else if (status === 'stopped') {
        this.isListening = false;
        this.onStateChange({ status: "IDLE", message: message || "Microphone idle" });
      } else if (status === 'error') {
        this.isListening = false;
        this.autoRestart = false;
        this.continuousMode = false;
        const errMsg = message || "Windows Speech Recognition error.";
        this.onStateChange({ status: "ERROR", message: errMsg });
        this.onLog({ type: 'WARNING', message: `[MIC] ${errMsg}` });
      }
    });
  }

  // Deepgram path: real streaming STT over a WebSocket. Works identically in
  // a plain browser tab and inside Electron's renderer since it's built
  // entirely from standard Web APIs (getUserMedia + MediaRecorder + WebSocket)
  // — no platform-specific bridge needed, unlike the browser/Electron engines.
  async _startDeepgram() {
    // Already connecting/connected. _dgSession is claimed synchronously,
    // before the getUserMedia await — checking only _deepgramSocket (set after
    // the await) let two overlapping starts both pass and open two sessions.
    if (this._dgSession || this._deepgramSocket) return;

    // Every async step and handler below checks it still owns the engine
    // before touching shared state. Without this, a superseded session's late
    // onclose tore down the live session's recorder and mic stream while the
    // UI kept showing LISTENING — the "says listening but isn't" bug.
    const session = {};
    this._dgSession = session;
    const isCurrent = () => this._dgSession === session;

    // Per-session flag: did Deepgram ever confirm it decoded real audio out of
    // what we sent it? Some environments produce a MediaRecorder stream that
    // Deepgram accepts (valid auth, valid WebSocket) but can never decode —
    // it then reports a Metadata message with duration 0 and closes cleanly
    // (code 1000). That looks like success at the socket level, so without
    // this flag the failure is invisible and the app just loops forever
    // "listening" while never hearing anything.
    this._dgSessionDecoded = false;

    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (!isCurrent()) return;
      this._dgSession = null;
      this.autoRestart = false;
      this.continuousMode = false;
      this.onStateChange({ status: "ERROR", message: `Microphone access denied: ${e.message}. Click the stop (■) button to retry listening.` });
      return;
    }
    // stopListening()/speak() ran while getUserMedia was pending — drop this
    // start instead of opening a session nobody asked for anymore.
    if (!isCurrent()) {
      micStream.getTracks().forEach(t => t.stop());
      return;
    }
    session.micStream = micStream;
    this._micStream = micStream;

    const params = new URLSearchParams({
      // nova-2 is plan-gated: Deepgram silently accepts the connection and
      // audio for it but never actually decodes anything on a trial key (every
      // session reports duration 0 and closes cleanly, with no error frame).
      // general is available on trial/free tiers and was verified end-to-end.
      model: 'general',
      language: 'en-US',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '300',
      alternatives: '3',
      // Boost the wake word — without it Deepgram hears "Aria" as "Area".
      keywords: 'Aria:5'
    });
    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ['token', this.deepgramApiKey]);
    session.socket = socket;
    this._deepgramSocket = socket;

    socket.onopen = () => {
      if (!isCurrent()) return;
      this.isListening = true;
      if (!this._silentRestart) this.playBeep(880, 0.1, 'sine');
      this._silentRestart = false;
      this.onStateChange({ status: "LISTENING", message: "Listening for voice input..." });

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(micStream, { mimeType });
      session.recorder = recorder;
      this._mediaRecorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      };
      recorder.start(250);
    };

    socket.onmessage = (event) => {
      if (!isCurrent()) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      // Deepgram's end-of-stream summary. duration > 0 confirms it actually
      // decoded audio this session, even on turns where nothing was said.
      if (data.type === 'Metadata') {
        if (data.duration > 0) this._dgSessionDecoded = true;
        return;
      }

      const alts = data.channel?.alternatives || [];
      const alt = alts[0];
      if (!alt || !alt.transcript) return;
      this._dgSessionDecoded = true;
      this._consecutiveErrors = 0;
      if (this.isSpeaking || this.suppressMic || (this.synthesis && this.synthesis.speaking)) return;
      if (alt.transcript.trim()) {
        this.onTranscript({
          text: alt.transcript,
          isFinal: Boolean(data.is_final),
          alternatives: alts.slice(1).map(a => a.transcript).filter(Boolean)
        });
      }
    };

    socket.onerror = () => {
      if (!isCurrent()) return;
      this._consecutiveErrors = (this._consecutiveErrors || 0) + 1;
    };

    socket.onclose = (event) => {
      // Always release this session's own resources...
      if (session.recorder && session.recorder.state !== 'inactive') {
        try { session.recorder.stop(); } catch (e) {}
      }
      micStream.getTracks().forEach(t => t.stop());

      // ...but only touch engine state if this is still the live session. A
      // stale session (we closed it ourselves via stopListening/speak, or it
      // was superseded) must not clobber whatever session is running now.
      if (!isCurrent()) return;
      this._dgSession = null;
      this._deepgramSocket = null;
      this._mediaRecorder = null;
      this._micStream = null;
      this.isListening = false;

      // A session that closes (cleanly or not) without Deepgram ever having
      // decoded audio is a real failure, not a quiet timeout — count it.
      if (!event.wasClean || !this._dgSessionDecoded) {
        this._consecutiveErrors = (this._consecutiveErrors || 0) + 1;
      }

      // Too many failures in a row — Deepgram isn't usable here. Fall back to
      // the built-in Windows mic bridge if this is Electron (it works
      // independently of Deepgram), otherwise stop and tell the user why.
      if ((this._consecutiveErrors || 0) >= 3) {
        this.autoRestart = false;
        this.continuousMode = false;
        this._consecutiveErrors = 0;
        if (this.isElectronMic) {
          this.engine = 'electron';
          if (!this._electronMicInitialized) {
            this._electronMicInitialized = true;
            this._initElectronMic();
          }
          this.onStateChange({ status: "IDLE", message: "Deepgram never decoded any audio in this app — switched to the built-in Windows microphone." });
          this.autoRestart = true;
          this.continuousMode = true;
          window.jarvisElectron.mic.start();
        } else {
          this.onStateChange({ status: "ERROR", message: "Deepgram never decoded any audio (no transcripts received) — check your microphone or Deepgram setup, then click the mic button to retry." });
        }
        return;
      }

      // Deepgram sessions can time out after a period of silence — quietly reconnect.
      if (this.autoRestart && this.continuousMode && !this.isSpeaking && !this.suppressMic) {
        // Don't leave LISTENING on screen while nothing is connected — the
        // next session's onopen flips it back once audio is flowing again.
        this.onStateChange({ status: "IDLE", message: "Microphone reconnecting..." });
        this._silentRestart = true;
        setTimeout(() => {
          if (this.continuousMode && !this.isSpeaking && !this.suppressMic) this._startDeepgram();
        }, 300);
      } else {
        this.onStateChange({ status: "IDLE", message: "Microphone idle" });
      }
    };
  }

  _stopDeepgram() {
    const socket = this._deepgramSocket;
    // Releasing the session token marks the close as intentional for its
    // onclose handler, and cancels a start still awaiting getUserMedia.
    this._dgSession = null;
    this._deepgramSocket = null;
    if (socket) {
      try { socket.close(); } catch (e) {}
    }
    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
      try { this._mediaRecorder.stop(); } catch (e) {}
    }
    this._mediaRecorder = null;
    if (this._micStream) {
      this._micStream.getTracks().forEach(t => t.stop());
      this._micStream = null;
    }
    this.isListening = false;
  }

  startListening() {
    this._ensureAudioContext();
    if (this.engine === 'browser' && !this.recognition) {
      this.onStateChange({ status: "ERROR", message: "Speech recognition not supported on this browser. Try Chrome/Edge or manual prompt input." });
      return false;
    }

    if (this.isSpeaking || (this.synthesis && this.synthesis.speaking)) {
      this.stopSpeaking();
    }

    this.suppressMic = false;
    this._fatalMicError = false;
    this._consecutiveErrors = 0;
    this.autoRestart = true;
    this.continuousMode = true;

    if (this.engine === 'deepgram') {
      this._startDeepgram();
      return true;
    }

    if (this.engine === 'electron') {
      // Force: a fresh page load / re-arm must get a guaranteed-fresh
      // recognizer — a long-lived start can be deaf or stale (e.g. the
      // recognizer outlived a hot reload that re-armed listening).
      window.jarvisElectron.mic.start({ force: true });
      return true;
    }

    try {
      this.recognition.start();
      return true;
    } catch (e) {
      console.warn("Already started or error", e);
      return false;
    }
  }

  stopListening() {
    this.autoRestart = false;
    this.continuousMode = false;
    this.suppressMic = true;
    if (this.engine === 'deepgram') {
      this._stopDeepgram();
    } else if (this.engine === 'electron') {
      window.jarvisElectron.mic.stop();
    } else if (this.recognition) {
      try {
        this.recognition.abort();
      } catch (e) {}
    }
    this.isListening = false;
    this.onStateChange({ status: "IDLE", message: "Voice listening paused" });
  }

  speak(text) {
    // Muted means no audio — but the full speaking lifecycle (SPEAKING
    // state, realistic timing, mic guard, resolve) still runs so the core
    // animation, hero text, and conversation flow behave exactly as if ARIA
    // spoke aloud. Returning instantly here used to strand the UI in the
    // thinking state forever.
    if (this.isMuted) return this._speakSilently(text);
    this._ensureAudioContext();

    // Each reply gets a generation number, bumped before stopSpeaking()
    // cancels the previous one. A superseded reply's onend/onerror (and its
    // 1200ms mic-guard timer) must still resolve its caller, but must not
    // reopen the mic — that used to call startListening() -> stopSpeaking()
    // and cut off the newer reply mid-sentence.
    const gen = ++this._speechGen;
    const isCurrentSpeech = () => this._speechGen === gen;

    // Immediately stop & suppress speech recognition while speaking
    this.suppressMic = true;
    this.autoRestart = false;
    if (this.engine === 'deepgram') {
      // Deepgram is metered per audio-minute — don't stream ARIA's own
      // voice to it, unlike the free Windows engine which can just stay
      // running (the suppressMic filter alone is enough there).
      this._stopDeepgram();
    } else if (this.recognition) {
      try {
        this.recognition.abort();
      } catch (e) {}
    }

    this.stopSpeaking();

    // ElevenLabs path: a saved Settings key switches ARIA's voice to
    // ElevenLabs synthesis (played through the main-process proxy). Any
    // failure falls back to the built-in Web Speech voice below.
    let elKey = null;
    try { elKey = localStorage.getItem('jarvis_elevenlabs_api_key'); } catch (e) {}
    if (elKey && typeof window !== 'undefined' && window.jarvisElectron && window.jarvisElectron.synthesizeElevenlabs) {
      return new Promise((resolve) => {
        this._speakElevenlabs(text, elKey, gen, isCurrentSpeech, resolve);
      });
    }

    if (!this.synthesis) return Promise.resolve();
    return new Promise((resolve) => {
      this._speakWithSynthesis(text, gen, isCurrentSpeech, resolve);
    });
  }

  /**
   * The built-in Web Speech voice — extracted from speak() so the
   * ElevenLabs path can fall back to it on any failure (bad key, no
   * quota, blocked playback, decode error) without duplicating the
   * lifecycle logic.
   */
  _speakWithSynthesis(text, gen, isCurrentSpeech, resolve) {
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      if (this.voice) utterance.voice = this.voice;
      utterance.rate = this.voiceRate;
      utterance.pitch = this.voicePitch;

      utterance.onstart = () => {
        this.isSpeaking = true;
        this.playFuturisticChime();
        this.onStateChange({ status: "SPEAKING", message: "ARIA speaking..." });
      };

      // Fires per spoken word (browser-dependent) — the closest thing to a
      // "how loud is JARVIS speaking right now" signal available, since
      // speechSynthesis exposes no real audio stream to analyze. intensity
      // is derived from word length as a cadence-based approximation.
      utterance.onboundary = (event) => {
        const length = typeof event.charLength === 'number' && event.charLength > 0 ? event.charLength : 5;
        this.onSpeechMeter({ active: true, intensity: Math.min(1, length / 12) });
      };

      utterance.onend = () => {
        if (!isCurrentSpeech()) return resolve();
        this.isSpeaking = false;
        this.onSpeechMeter({ active: false, intensity: 0 });
        this.onStateChange({ status: "IDLE", message: "System online" });

        // Enforce guard delay so echo from speakers dies down before mic reactivates
        setTimeout(() => {
          if (isCurrentSpeech()) {
            this.suppressMic = false;
            if (this.continuousMode) this.startListening();
          }
          resolve();
        }, 1200);
      };

      utterance.onerror = (err) => {
        if (!isCurrentSpeech()) return resolve();
        // Log the actionable detail (err.error: 'canceled' | 'interrupted' |
        // 'synthesis-failed' | ...) instead of "[object SpeechSynthesisErrorEvent]".
        const reason = (err && typeof err === 'object' && 'error' in err) ? err.error : (err ? String(err) : 'unknown');
        console.warn(`TTS Error (${reason})`);
        this.isSpeaking = false;
        this.onSpeechMeter({ active: false, intensity: 0 });
        this.suppressMic = false;
        this.onStateChange({ status: "IDLE", message: "System online" });
        if (this.continuousMode) this.startListening();
        resolve();
      };

      this.synthesis.speak(utterance);
    } catch (e) {
      console.warn(`TTS start failed (${e && e.message ? e.message : 'unknown'})`);
      this.isSpeaking = false;
      this.suppressMic = false;
      resolve();
    }
  }

  /**
   * ElevenLabs TTS: requests mp3 synthesis through the main-process proxy
   * (the key travels only renderer→preload, same trust boundary as every
   * other harness call), plays it via an <audio> element and drives the
   * same SPEAKING lifecycle as the built-in voice (state, chime, meter
   * pulses, mic guard). Voice follows the Settings gender preference
   * (premade catalog: Rachel / Adam). Any failure falls back to
   * _speakWithSynthesis so ARIA always still answers out loud.
   */
  _speakElevenlabs(text, apiKey, gen, isCurrentSpeech, resolve) {
    const gender = loadSettings().voiceGender === 'female' ? 'female' : 'male';
    // A Settings-saved Voice ID (elevenlabs.io → Voices) overrides the
    // premade catalog default; re-read per call so it hot-swaps.
    let customVoiceId = null;
    try { customVoiceId = localStorage.getItem('jarvis_elevenlabs_voice_id'); } catch (e) {}
    const voiceId = (customVoiceId && customVoiceId.trim())
      || (gender === 'female'
        ? '21m00Tcm4TlvDq8ikWAM' // Rachel
        : 'pNInz6obpgDQGcFmaJgB'); // Adam

    const finish = () => {
      if (!isCurrentSpeech()) return resolve();
      this.isSpeaking = false;
      this.onSpeechMeter({ active: false, intensity: 0 });
      this.onStateChange({ status: "IDLE", message: "System online" });
      // Same echo guard as the built-in path.
      setTimeout(() => {
        if (isCurrentSpeech()) {
          this.suppressMic = false;
          if (this.continuousMode) this.startListening();
        }
        resolve();
      }, 1200);
    };
    this._elFinish = finish;

    const fallback = (why) => {
      console.warn(`[TTS] ElevenLabs unavailable (${why}) — falling back to built-in voice.`);
      if (isCurrentSpeech()) {
        this._elFinish = null;
        this._speakWithSynthesis(text, gen, isCurrentSpeech, resolve);
      } else {
        resolve();
      }
    };

    window.jarvisElectron.synthesizeElevenlabs(text, apiKey, voiceId).then((res) => {
      if (!res || !res.success || !res.base64) {
        fallback(res && res.message ? res.message : 'unknown error');
        return;
      }
      if (!isCurrentSpeech()) return resolve();
      try {
        const bin = atob(res.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: res.mime || 'audio/mpeg' });
        const audio = new Audio(URL.createObjectURL(blob));
        this._elAudio = audio;
        audio.onplay = () => {
          if (!isCurrentSpeech()) return;
          this.isSpeaking = true;
          this.playFuturisticChime();
          this.onStateChange({ status: "SPEAKING", message: "ARIA speaking..." });
          // Streamed audio has no word-boundary events — keep the
          // visualizer alive with the muted-reply metronome.
          this._elMeterTimer = setInterval(() => {
            if (isCurrentSpeech()) {
              this.onSpeechMeter({ active: true, intensity: 0.45 + Math.random() * 0.3 });
            }
          }, 400);
          if (typeof this._elMeterTimer.unref === 'function') this._elMeterTimer.unref();
        };
        audio.onended = () => {
          if (this._elAudio === audio) this._elAudio = null;
          try { URL.revokeObjectURL(audio.src); } catch (e) {}
          finish();
        };
        audio.onerror = () => {
          if (this._elAudio === audio) this._elAudio = null;
          fallback('audio playback error');
        };
        audio.play().catch(() => {
          if (this._elAudio === audio) this._elAudio = null;
          fallback('audio play() blocked');
        });
      } catch (e) {
        fallback('decode error');
      }
    }).catch((e) => {
      fallback(e && e.message ? e.message : 'request failed');
    });
  }


  /**
   * Muted reply: no audio, but the full speaking lifecycle still runs —
   * mic suppression, SPEAKING state, realistic timing, meter pulses, mic
   * guard, resolve — so the core animation, hero text, and conversation
   * flow behave exactly like a voiced reply.
   */
  _speakSilently(text) {
    // Same superseded-reply guard as speak() — bumped before stopSpeaking()
    // settles any previous muted reply.
    const gen = ++this._speechGen;
    this.suppressMic = true;
    this.autoRestart = false;
    if (this.engine === 'deepgram') {
      this._stopDeepgram();
    } else if (this.recognition) {
      try {
        this.recognition.abort();
      } catch (e) {}
    }
    this.stopSpeaking();

    // Mirror real speech timing (~65ms/char, clamped 1.2s–12s) so the
    // yellow thinking streak hands off to the full speaking glow and back
    // to idle on the same cadence as a voiced reply.
    const speechMs = Math.min(12000, Math.max(1200, (text ? text.length : 0) * 65));
    this.isSpeaking = true;
    this.onStateChange({ status: "SPEAKING", message: "ARIA speaking..." });
    // The built-in path gets per-word boundary pulses; silence gets a
    // gentle metronome so the visualizer keeps breathing throughout.
    this._silentMeterTimer = setInterval(() => {
      this.onSpeechMeter({ active: true, intensity: 0.4 + Math.random() * 0.3 });
    }, 400);
    if (this._silentMeterTimer && typeof this._silentMeterTimer.unref === 'function') {
      this._silentMeterTimer.unref();
    }
    return new Promise((resolve) => {
      const finish = () => {
        this._silentTimer = null;
        if (this._silentMeterTimer) {
          clearInterval(this._silentMeterTimer);
          this._silentMeterTimer = null;
        }
        this.isSpeaking = false;
        this.onSpeechMeter({ active: false, intensity: 0 });
        this.onStateChange({ status: "IDLE", message: "System online" });
        setTimeout(() => {
          if (this._speechGen === gen) {
            this.suppressMic = false;
            if (this.continuousMode) this.startListening();
          }
          resolve();
        }, 1200);
      };
      this._silentFinish = finish;
      this._silentTimer = setTimeout(() => {
        this._silentFinish = null;
        finish();
      }, speechMs);
    });
  }

  stopSpeaking() {
    if (this.synthesis && this.synthesis.speaking) {
      this.synthesis.cancel();
    }
    // Cut off any ElevenLabs playback and settle its pending lifecycle so
    // the awaited promise (and the serialized input queue) never hangs.
    if (this._elAudio) {
      const audio = this._elAudio;
      this._elAudio = null;
      try { audio.pause(); } catch (e) {}
      try { audio.src = ''; } catch (e) {}
    }
    if (this._elMeterTimer) {
      clearInterval(this._elMeterTimer);
      this._elMeterTimer = null;
    }
    if (this._elFinish) {
      const finish = this._elFinish;
      this._elFinish = null;
      finish();
    }
    // Settle a cut-off silent reply through its normal finish path so its
    // caller (and the serialized input queue) never hangs.
    if (this._silentFinish) {
      const finish = this._silentFinish;
      this._silentFinish = null;
      if (this._silentTimer) {
        clearTimeout(this._silentTimer);
        this._silentTimer = null;
      }
      finish();
    }
    if (this._silentMeterTimer) {
      clearInterval(this._silentMeterTimer);
      this._silentMeterTimer = null;
    }
    this.isSpeaking = false;
  }

  // --- Web Audio Sound FX Generators ---
  playBeep(freq = 600, duration = 0.08, type = 'sine') {
    if (!this.audioCtx) return;
    try {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);
      gain.gain.setValueAtTime(0.08, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start();
      osc.stop(this.audioCtx.currentTime + duration);
    } catch (e) {}
  }

  playFuturisticChime() {
    if (!this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      const freqs = [440, 660, 880, 1320];
      freqs.forEach((f, index) => {
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, now + index * 0.04);
        gain.gain.setValueAtTime(0.05, now + index * 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.04 + 0.15);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(now + index * 0.04);
        osc.stop(now + index * 0.04 + 0.15);
      });
    } catch (e) {}
  }

  playSearchLaunchSound() {
    if (!this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.25);
      gain.gain.setValueAtTime(0.07, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    } catch (e) {}
  }

  // Timer expiry ringtone — a synthwave stab (detuned saw arpeggio in A
  // minor over sub-bass pulses, closed by a filtered noise sweep) in the
  // app's cyberpunk register. Pure WebAudio, same discipline as the FX
  // above: no audio assets, everything from oscillators + a noise buffer.
  playTimerRingtone() {
    if (!this.audioCtx) return;
    try {
      const ctx = this.audioCtx;
      const now = ctx.currentTime;

      // --- Detuned saw arpeggio lead (A3 → C5 zig-zag, 8 steps) ---
      const arp = [220, 261.63, 329.63, 440, 523.25, 440, 329.63, 303.37];
      const step = 0.085;
      arp.forEach((freq, i) => {
        const start = now + i * step;
        // Two oscillators per note, detuned ±9 cents, sawtooth stacked for
        // the classic synthwave width.
        [-9, 9].forEach((cents) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(freq, start);
          osc.detune.setValueAtTime(cents, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.055, start + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + 0.18);
        });
      });

      // --- Sub-bass pulse train every two arp steps (E1/A1 alternation) ---
      const bassNotes = [41.2, 55, 41.2, 55];
      bassNotes.forEach((freq, i) => {
        const start = now + i * 0.34;
        const osc = ctx.createOscillator();
        const lp = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq * 2, start);
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(320, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
        osc.connect(lp);
        lp.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.32);
      });

      // --- Closing noise sweep ("data burst") x2, band-passed rising ---
      const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.22), ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      [0.02, 0.68].forEach((offset, i) => {
        const src = ctx.createBufferSource();
        const bp = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        const start = now + offset;
        src.buffer = noiseBuf;
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.8, start);
        const from = i === 0 ? 1400 : 2400;
        bp.frequency.setValueAtTime(from, start);
        bp.frequency.exponentialRampToValueAtTime(from * 2.4, start + 0.2);
        gain.gain.setValueAtTime(0.04, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
        src.connect(bp);
        bp.connect(gain);
        gain.connect(ctx.destination);
        src.start(start);
      });
    } catch (e) {}
  }
}
