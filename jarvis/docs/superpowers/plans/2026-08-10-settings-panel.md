# Settings Panel & First-Run Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings panel (Google-search tab toggle, voice gender, voice-output meter toggle, OpenRouter/Deepgram API key fields) and make the project runnable by a new user without reading source code (`README.md`, `.env.example`).

**Architecture:** A new `src/settings.js` module is a plain localStorage-backed preferences store (`{ openTabOnSearch, voiceGender, soundMeterEnabled }`), read ad hoc by `jarvis-core.js` and `voice-engine.js` at the point of use — no constructor prop-drilling. API keys keep using their existing individual localStorage keys (`jarvis_openrouter_api_key`, `jarvis_deepgram_api_key`), which `jarvis-core.js`/`voice-engine.js` already read; the new Settings modal just gives them a UI. The "voice output meter" is a cadence-driven approximation built from `SpeechSynthesisUtterance.onboundary` events, since browsers expose no real audio stream for native TTS.

**Tech Stack:** Vanilla JS (ES modules), Vite, Electron, `node --test` for unit tests. No new dependencies.

**Note on version control:** This project has no git repository (`git status` confirms `fatal: not a git repository`). Steps below say "Checkpoint" instead of "Commit" — verify the step worked, then move on. If the user later runs `git init`, nothing here depends on git history existing.

---

## File Structure

- **Create** `src/settings.js` — preferences load/save.
- **Create** `test/settings.test.js` — tests for the above.
- **Create** `test/helpers/jarvis-test-utils.js` — extracts the `createJarvis()` mock factory currently duplicated only in `test/jarvis-core.conversation-memory.test.js`, so the new settings-wiring test can reuse it instead of copy-pasting it.
- **Modify** `test/jarvis-core.conversation-memory.test.js` — import `createJarvis` from the new helper instead of defining it inline.
- **Create** `test/jarvis-core.settings.test.js` — confirms the Google-search branch respects `openTabOnSearch`.
- **Modify** `src/jarvis-core.js:1-9,158-163` — import `loadSettings`, use it in the Google-search branch.
- **Modify** `src/voice-engine.js` — gender-aware voice selection (`applyVoicePreference()`), `onSpeechMeter` callback wired through `onboundary`/`onend`/`onerror`.
- **Modify** `index.html` — gear button in header, speech-meter bar row near the arc reactor, settings modal markup.
- **Modify** `src/main.js` — `initSettingsPanel()` wiring, speech-meter rendering/decay loop.
- **Modify** `src/styles.css` — modal, toggle switch, radio group, speech-meter bar styles.
- **Create** `README.md` — setup/run/build/test instructions.
- **Create** `.env.example` — documents all four `VITE_*` variables.

---

## Task 1: `settings.js` preferences store

**Files:**
- Create: `src/settings.js`
- Test: `test/settings.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/settings.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};

const { loadSettings, saveSettings, DEFAULT_SETTINGS } = await import('../src/settings.js');

test('loadSettings returns defaults when nothing stored', () => {
  global.localStorage.store.clear();
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

test('saveSettings persists a partial update and loadSettings reflects it', () => {
  global.localStorage.store.clear();
  saveSettings({ openTabOnSearch: false });
  const settings = loadSettings();
  assert.equal(settings.openTabOnSearch, false);
  assert.equal(settings.voiceGender, DEFAULT_SETTINGS.voiceGender, 'unrelated defaults stay intact');
});

test('saveSettings merges over previous saves rather than replacing wholesale', () => {
  global.localStorage.store.clear();
  saveSettings({ voiceGender: 'female' });
  saveSettings({ soundMeterEnabled: false });
  const settings = loadSettings();
  assert.equal(settings.voiceGender, 'female');
  assert.equal(settings.soundMeterEnabled, false);
});

test('loadSettings falls back to defaults if the stored value is corrupt JSON', () => {
  global.localStorage.store.clear();
  global.localStorage.setItem('jarvis_settings', '{not valid json');
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/settings.test.js"`
Expected: FAIL — `Cannot find module '../src/settings.js'` (or similar import error).

- [ ] **Step 3: Write the implementation**

```javascript
// src/settings.js
/**
 * JARVIS Settings
 * Small localStorage-backed preferences store for user-facing toggles.
 * API keys are NOT stored here — they keep using their own existing
 * localStorage keys (jarvis_openrouter_api_key, jarvis_deepgram_api_key,
 * jarvis_steam_api_key, jarvis_steam_id), already read directly by
 * jarvis-core.js / voice-engine.js / steam-library.js.
 */

const STORAGE_KEY = 'jarvis_settings';

export const DEFAULT_SETTINGS = {
  openTabOnSearch: true,
  voiceGender: 'male',
  soundMeterEnabled: true
};

export function loadSettings() {
  let stored = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (e) {
    stored = {};
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(partial) {
  const merged = { ...loadSettings(), ...partial };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test "test/settings.test.js"`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Checkpoint**

No git repo — just confirm the test output above shows all 4 passing before moving on.

---

## Task 2: Extract shared JarvisCore test helper

**Files:**
- Create: `test/helpers/jarvis-test-utils.js`
- Modify: `test/jarvis-core.conversation-memory.test.js`

- [ ] **Step 1: Create the helper, moving `createJarvis()` out of the conversation-memory test**

```javascript
// test/helpers/jarvis-test-utils.js
/**
 * Shared test setup for JarvisCore specs: shims the localStorage global that
 * JarvisCore's constructor chain reads, and builds a JarvisCore wired to
 * inert mocks (no voice synthesis, no browser automation, no network) with
 * an OpenRouter stub that records every (input, context) call instead of
 * hitting the real API.
 */

global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};

const { JarvisCore } = await import('../../src/jarvis-core.js');

export function createJarvis(harnessOverrides = {}) {
  const voiceEngine = {
    playBeep: () => {},
    playSearchLaunchSound: () => {},
    speak: async () => {}
  };
  const harness = {
    executeGoogleSearch: async () => ({ summary: 'mock search summary.' }),
    openWebsite: () => ({}),
    ...harnessOverrides
  };

  const jarvis = new JarvisCore(voiceEngine, harness);

  jarvis.llmCalls = [];
  jarvis.openRouter.chatWithJarvis = async (input, context = []) => {
    jarvis.llmCalls.push({ input, context: context.map(m => ({ ...m })) });
    return `mock-answer:${jarvis.llmCalls.length}`;
  };

  return jarvis;
}
```

- [ ] **Step 2: Update the conversation-memory test to import the helper**

In `test/jarvis-core.conversation-memory.test.js`, the file currently starts
with (lines 1-43):

```javascript
/**
 * Tests for JarvisCore's short-term conversation memory (src/jarvis-core.js).
 * Runs headless under plain Node (`node --test test/`) instead of the Electron
 * app, so no manual setup/rerun is needed to check follow-up-question behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// JarvisCore (and SteamLibrary underneath it) read localStorage during
// construction to look for cached API keys. Node has no such global, so we
// shim a trivial in-memory version before importing the module under test.
global.localStorage = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};

const { JarvisCore } = await import('../src/jarvis-core.js');

/**
 * Builds a JarvisCore wired to inert mocks (no voice synthesis, no browser
 * automation, no network) and a stubbed OpenRouter client that records every
 * (input, context) pair it's called with instead of hitting the real API.
 */
function createJarvis() {
  const voiceEngine = {
    playBeep: () => {},
    playSearchLaunchSound: () => {},
    speak: async () => {}
  };
  const harness = {
    executeGoogleSearch: async () => ({ summary: 'mock search summary.' }),
    openWebsite: () => ({})
  };

  const jarvis = new JarvisCore(voiceEngine, harness);

  jarvis.llmCalls = [];
  jarvis.openRouter.chatWithJarvis = async (input, context = []) => {
    jarvis.llmCalls.push({ input, context: context.map(m => ({ ...m })) });
    return `mock-answer:${jarvis.llmCalls.length}`;
  };

  return jarvis;
}
```

Replace that entire block (everything up to and including the closing `}` of
`createJarvis`) with:

```javascript
/**
 * Tests for JarvisCore's short-term conversation memory (src/jarvis-core.js).
 * Runs headless under plain Node (`node --test test/`) instead of the Electron
 * app, so no manual setup/rerun is needed to check follow-up-question behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
```

Leave the four `test(...)` blocks below it exactly as they are — they only
call `createJarvis()`, which now comes from the import.

- [ ] **Step 3: Run the full suite to confirm nothing broke**

Run: `node --test "test/**/*.test.js"`
Expected: PASS — same 4 conversation-memory tests as before, plus the 4 new
settings tests from Task 1 (8 total).

- [ ] **Step 4: Checkpoint**

No git repo — confirm the 8-test PASS output above before moving on.

---

## Task 3: Wire `openTabOnSearch` into the Google-search branch

**Files:**
- Test: `test/jarvis-core.settings.test.js`
- Modify: `src/jarvis-core.js:1-9` (imports), `src/jarvis-core.js:158-163` (Google search branch)

- [ ] **Step 1: Write the failing test**

```javascript
// test/jarvis-core.settings.test.js
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('Google search branch opens a tab when openTabOnSearch is true (default)', async () => {
  const calls = [];
  const jarvis = createJarvis({
    executeGoogleSearch: async (query, openTab) => {
      calls.push({ query, openTab });
      return { summary: 'mock summary' };
    }
  });

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].openTab, true);
});

test('Google search branch respects openTabOnSearch = false from settings', async () => {
  saveSettings({ openTabOnSearch: false });
  const calls = [];
  const jarvis = createJarvis({
    executeGoogleSearch: async (query, openTab) => {
      calls.push({ query, openTab });
      return { summary: 'mock summary' };
    }
  });

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].openTab, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/jarvis-core.settings.test.js"`
Expected: FAIL on the second test — `calls[0].openTab` is `true`, not `false`
(the branch still hardcodes `true`).

- [ ] **Step 3: Wire the setting into `jarvis-core.js`**

In `src/jarvis-core.js`, change the import block at the top:

```javascript
import { SteamHarness } from './steam-harness.js';
import { AutonomousToolReasoner } from './autonomous-tool-reasoner.js';
import { OpenRouterClient } from './openrouter-client.js';
import { loadSettings } from './settings.js';
```

Then in the Google-search branch (`processUserInput`, step 4), change:

```javascript
      const [searchResult, llmAnswer] = await Promise.all([
        this.harness.executeGoogleSearch(decision.params.query, true),
```

to:

```javascript
      const [searchResult, llmAnswer] = await Promise.all([
        this.harness.executeGoogleSearch(decision.params.query, loadSettings().openTabOnSearch),
```

(The rest of that `Promise.all` call — the `chatWithJarvis` line — is unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test "test/**/*.test.js"`
Expected: PASS — 10 tests total, 0 failures.

- [ ] **Step 5: Checkpoint**

No git repo — confirm the 10-test PASS output above before moving on.

---

## Task 4: Voice gender preference + speech-output meter callback

**Files:**
- Modify: `src/voice-engine.js`

No automated test for this task — the codebase has no DOM/Web-Speech-API test
harness (jsdom/happy-dom isn't a dependency, and adding one just for this
would be disproportionate). Verify manually in Task 6.

- [ ] **Step 1: Add the `loadSettings` import**

At the top of `src/voice-engine.js`, add:

```javascript
import { loadSettings } from './settings.js';
```

- [ ] **Step 2: Replace `_initSpeechSynthesis` with a gender-aware, re-callable version**

Replace the existing `_initSpeechSynthesis()` method:

```javascript
  _initSpeechSynthesis() {
    if (!this.synthesis) return;
    
    const loadVoices = () => {
      const voices = this.synthesis.getVoices();
      // Try finding a sleek British male/female voice or default AI sounding voice
      this.voice = 
        voices.find(v => v.name.includes("Daniel") || v.name.includes("Oliver") || v.name.includes("Google UK English Male")) ||
        voices.find(v => v.name.includes("Natural") || v.name.includes("Google")) ||
        voices.find(v => v.lang.startsWith("en")) ||
        voices[0];
    };

    loadVoices();
    if (this.synthesis.onvoiceschanged !== undefined) {
      this.synthesis.onvoiceschanged = loadVoices;
    }
  }
```

with:

```javascript
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
```

- [ ] **Step 3: Add the name-heuristic lists as static class fields**

Just below `export class VoiceEngine {`, add:

```javascript
  static VOICE_NAMES_MALE = ["Daniel", "Oliver", "Google UK English Male", "David", "Guy", "Ryan"];
  static VOICE_NAMES_FEMALE = ["Zira", "Samantha", "Susan", "Victoria", "Google UK English Female", "Hazel", "Aria", "Jenny"];

```

- [ ] **Step 4: Add the `onSpeechMeter` callback option**

In the constructor, alongside the existing `onTranscript`/`onStateChange`/`onVolumeChange` option defaults, add:

```javascript
    this.onSpeechMeter = options.onSpeechMeter || (() => {});
```

- [ ] **Step 5: Fire the callback from speech boundary/end/error events**

In `speak(text)`, the utterance handlers currently look like this:

```javascript
      utterance.onstart = () => {
        this.isSpeaking = true;
        this.playFuturisticChime();
        this.onStateChange({ status: "SPEAKING", message: "JARVIS speaking..." });
      };

      utterance.onend = () => {
        this.isSpeaking = false;
        this.onStateChange({ status: "IDLE", message: "System online" });

        // Enforce guard delay so echo from speakers dies down before mic reactivates
        setTimeout(() => {
          this.suppressMic = false;
          if (this.continuousMode) this.startListening();
          resolve();
        }, 1200);
      };

      utterance.onerror = (err) => {
        console.warn("TTS Error:", err);
        this.isSpeaking = false;
        this.suppressMic = false;
        this.onStateChange({ status: "IDLE", message: "System online" });
        if (this.continuousMode) this.startListening();
        resolve();
      };
```

Change them to:

```javascript
      utterance.onstart = () => {
        this.isSpeaking = true;
        this.playFuturisticChime();
        this.onStateChange({ status: "SPEAKING", message: "JARVIS speaking..." });
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
        this.isSpeaking = false;
        this.onSpeechMeter({ active: false, intensity: 0 });
        this.onStateChange({ status: "IDLE", message: "System online" });

        // Enforce guard delay so echo from speakers dies down before mic reactivates
        setTimeout(() => {
          this.suppressMic = false;
          if (this.continuousMode) this.startListening();
          resolve();
        }, 1200);
      };

      utterance.onerror = (err) => {
        console.warn("TTS Error:", err);
        this.isSpeaking = false;
        this.onSpeechMeter({ active: false, intensity: 0 });
        this.suppressMic = false;
        this.onStateChange({ status: "IDLE", message: "System online" });
        if (this.continuousMode) this.startListening();
        resolve();
      };
```

- [ ] **Step 6: Run the full test suite to confirm nothing broke**

Run: `node --test "test/**/*.test.js"`
Expected: PASS — 10 tests, 0 failures (this task has no new automated tests,
but must not regress the existing ones — `voice-engine.js` isn't imported by
any current test, so this is a quick sanity check).

- [ ] **Step 7: Checkpoint**

No git repo — confirm the PASS output above before moving on.

---

## Task 5: Settings modal UI, speech meter bars, and header gear button

**Files:**
- Modify: `index.html`
- Modify: `src/main.js`
- Modify: `src/styles.css`

No automated test — pure DOM/CSS wiring, verified manually in Task 6.

- [ ] **Step 1: Add the gear button to the header**

In `index.html`, inside `<div style="display: flex; align-items: center; gap: 12px;">` (the container that already holds `#muteBtn` and the status badge), add a new button **before** `#muteBtn`:

```html
        <button class="btn-harness" id="settingsBtn" style="border-color: var(--border-cyan); color: var(--cyan-bright);" title="Settings">
          ⚙️ SETTINGS
        </button>

        <button class="btn-harness" id="muteBtn" style="border-color: var(--border-gold); color: var(--gold-glow);" title="Toggle Voice Output">
          🔊 VOICE: ON
        </button>
```

- [ ] **Step 2: Add the speech-meter bar row near the arc reactor**

In `index.html`, right after the closing `</div>` of `.arc-reactor-container` and before `<div class="voice-controls">`, add:

```html
        <div class="speech-meter" id="speechMeter" title="Voice output meter — reacts to JARVIS's speech cadence, not a literal decibel reading">
          <div class="speech-meter-bar"></div>
          <div class="speech-meter-bar"></div>
          <div class="speech-meter-bar"></div>
          <div class="speech-meter-bar"></div>
          <div class="speech-meter-bar"></div>
          <div class="speech-meter-bar"></div>
          <div class="speech-meter-bar"></div>
          <div class="speech-meter-bar"></div>
        </div>
```

- [ ] **Step 3: Add the settings modal markup**

In `index.html`, right before `<script type="module" src="/src/main.js"></script>` (i.e. as a sibling of `#app`, not inside it), add:

```html
  <!-- Settings Modal -->
  <div class="settings-modal" id="settingsModal">
    <div class="settings-backdrop" id="settingsBackdrop"></div>
    <div class="settings-panel">
      <div class="settings-panel-header">
        <span class="panel-title">⚙️ JARVIS Settings</span>
        <button class="settings-close-btn" id="settingsCloseBtn" title="Close">✕</button>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">General</div>
        <label class="settings-row">
          <span>Open browser tab when searching Google</span>
          <input type="checkbox" id="openTabToggle" class="settings-switch" />
        </label>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Voice</div>
        <div class="settings-row">
          <span>Voice gender</span>
          <div class="settings-radio-group">
            <label><input type="radio" name="voiceGender" id="voiceGenderMale" /> Male</label>
            <label><input type="radio" name="voiceGender" id="voiceGenderFemale" /> Female</label>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Voice Output Meter</div>
        <label class="settings-row">
          <span>Show meter while JARVIS is speaking</span>
          <input type="checkbox" id="soundMeterToggle" class="settings-switch" />
        </label>
        <div class="settings-hint">
          Approximates loudness from speech cadence — browsers don't expose real
          audio levels for built-in text-to-speech.
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">🔑 API Keys</div>
        <div class="settings-hint">
          <a href="https://openrouter.ai/keys" target="_blank">Get an OpenRouter key</a>
          (required for conversational answers) ·
          <a href="https://console.deepgram.com" target="_blank">Get a Deepgram key</a>
          (optional, improves speech recognition)
        </div>
        <input type="password" id="openrouterKeyInput" class="steam-input" placeholder="OpenRouter API Key" autocomplete="off" />
        <input type="password" id="deepgramKeyInput" class="steam-input" placeholder="Deepgram API Key (optional)" autocomplete="off" />
        <div class="settings-hint">Restart JARVIS after adding/changing the Deepgram key to activate it.</div>
        <button class="btn-steam-save" id="apiKeysSaveBtn">SAVE KEYS</button>
        <div class="steam-library-status" id="apiKeysStatus"></div>
      </div>
    </div>
  </div>
```

- [ ] **Step 4: Add the settings/meter CSS**

Append to the end of `src/styles.css`:

```css
/* Settings Modal */
.settings-modal {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: none;
  align-items: center;
  justify-content: center;
}

.settings-modal.open {
  display: flex;
}

.settings-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(2, 5, 12, 0.75);
  backdrop-filter: blur(4px);
}

.settings-panel {
  position: relative;
  width: min(480px, 92vw);
  max-height: 86vh;
  overflow-y: auto;
  background: var(--bg-card);
  backdrop-filter: blur(20px);
  border: 1px solid var(--border-cyan);
  border-radius: 16px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 40px rgba(0, 243, 255, 0.15);
}

.settings-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border-cyan);
  padding-bottom: 10px;
}

.settings-close-btn {
  background: transparent;
  border: 1px solid var(--border-cyan);
  color: var(--cyan-bright);
  border-radius: 8px;
  width: 28px;
  height: 28px;
  cursor: pointer;
  font-size: 0.9rem;
}

.settings-close-btn:hover {
  background: rgba(0, 243, 255, 0.15);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settings-section-title {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--cyan-bright);
  letter-spacing: 1px;
  text-transform: uppercase;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 0.85rem;
  color: var(--text-main);
  cursor: pointer;
}

.settings-hint {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-dim);
  line-height: 1.5;
}

.settings-hint a {
  color: var(--cyan-bright);
  text-decoration: none;
}

.settings-hint a:hover {
  text-decoration: underline;
}

.settings-radio-group {
  display: flex;
  gap: 14px;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--text-dim);
}

.settings-radio-group label {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}

/* Y/N toggle switch, built from a styled checkbox */
.settings-switch {
  appearance: none;
  width: 42px;
  height: 22px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid var(--border-cyan);
  position: relative;
  cursor: pointer;
  outline: none;
  transition: background 0.2s ease;
  flex-shrink: 0;
}

.settings-switch::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text-dim);
  transition: transform 0.2s ease, background 0.2s ease;
}

.settings-switch:checked {
  background: rgba(0, 243, 255, 0.25);
  border-color: var(--cyan-glow);
}

.settings-switch:checked::before {
  transform: translateX(20px);
  background: var(--cyan-glow);
  box-shadow: 0 0 8px var(--cyan-glow);
}

/* Voice Output Meter */
.speech-meter {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 28px;
}

.speech-meter.hidden {
  display: none;
}

.speech-meter-bar {
  width: 6px;
  height: 8px;
  border-radius: 2px;
  background: rgba(0, 243, 255, 0.15);
  border: 1px solid rgba(0, 243, 255, 0.2);
  transition: height 0.08s ease, background 0.08s ease;
}

.speech-meter-bar.lit {
  height: 26px;
  background: var(--gold-glow);
  border-color: var(--gold-glow);
  box-shadow: 0 0 8px var(--gold-glow);
}
```

- [ ] **Step 5: Add the `loadSettings`/`saveSettings` import to `main.js`**

At the top of `src/main.js`, add:

```javascript
import { loadSettings, saveSettings } from './settings.js';
```

- [ ] **Step 6: Add speech-meter DOM refs and rendering functions**

In `src/main.js`, alongside the other DOM element references near the top of
the file (after the `visualizerCanvas` const), add:

```javascript
const speechMeter = document.getElementById('speechMeter');
const speechMeterBars = speechMeter ? Array.from(speechMeter.querySelectorAll('.speech-meter-bar')) : [];
let meterLevel = 0; // 0..1 current displayed level, decays over time
let meterDecayFrameId = null;
```

Then, after the `startVisualizerAnimation` function definition (still at
module scope, not inside `initApp`), add:

```javascript
/**
 * Renders the speech-output meter bars from the current meterLevel (0..1).
 */
function renderMeter() {
  const litCount = Math.round(meterLevel * speechMeterBars.length);
  speechMeterBars.forEach((bar, i) => {
    bar.classList.toggle('lit', i < litCount);
  });
}

/**
 * Decays meterLevel toward 0 each frame, so a pulse from one word fades out
 * smoothly instead of vanishing instantly at the next boundary event.
 */
function decayMeterLoop() {
  meterLevel = Math.max(0, meterLevel - 0.05);
  renderMeter();
  if (meterLevel > 0) {
    meterDecayFrameId = requestAnimationFrame(decayMeterLoop);
  } else {
    meterDecayFrameId = null;
  }
}

/**
 * Pulses the meter to at least `intensity` (0..1), called on each spoken
 * word boundary from VoiceEngine's onSpeechMeter callback.
 */
function pulseMeter(intensity) {
  meterLevel = Math.max(meterLevel, intensity);
  renderMeter();
  if (!meterDecayFrameId) {
    meterDecayFrameId = requestAnimationFrame(decayMeterLoop);
  }
}

/**
 * Shows/hides the meter row per the soundMeterEnabled setting.
 */
function applySoundMeterVisibility(enabled) {
  if (!speechMeter) return;
  speechMeter.classList.toggle('hidden', !enabled);
}
```

- [ ] **Step 7: Wire `onSpeechMeter` into the `VoiceEngine` constructor call**

In `src/main.js`, inside `initApp()`, the `voiceEngine = new VoiceEngine({ ... })`
call currently has `onTranscript` and `onStateChange` options. Add a third:

```javascript
    onStateChange: (state) => {
      updateStatus(state);
      if (micBtn) {
        if (state.status === 'LISTENING') {
          micBtn.classList.add('active');
        } else if (state.status === 'IDLE' || state.status === 'ERROR') {
          micBtn.classList.remove('active');
        }
      }
    },
    onSpeechMeter: ({ active, intensity }) => {
      if (active) pulseMeter(intensity);
    }
```

(This replaces the closing `}` of the `onStateChange` option with `},` and
adds the new option — the object literal now has three properties instead of
two.)

- [ ] **Step 8: Add `initSettingsPanel()` and call it from `initApp()`**

In `src/main.js`, add this new function after `initApp()`'s closing brace
(alongside `populateSteamGames` and `startVisualizerAnimation`):

```javascript
/**
 * Wires up the Settings modal: open/close, loading current values on open,
 * saving on change, and applying live effects (voice re-pick, meter
 * visibility, API key hot-update) without requiring a reload.
 */
function initSettingsPanel() {
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  const openTabToggle = document.getElementById('openTabToggle');
  const voiceGenderMale = document.getElementById('voiceGenderMale');
  const voiceGenderFemale = document.getElementById('voiceGenderFemale');
  const soundMeterToggle = document.getElementById('soundMeterToggle');
  const openrouterKeyInput = document.getElementById('openrouterKeyInput');
  const deepgramKeyInput = document.getElementById('deepgramKeyInput');
  const apiKeysSaveBtn = document.getElementById('apiKeysSaveBtn');
  const apiKeysStatus = document.getElementById('apiKeysStatus');

  if (!settingsBtn || !settingsModal) return;

  const settings = loadSettings();
  if (openTabToggle) openTabToggle.checked = settings.openTabOnSearch;
  if (voiceGenderMale) voiceGenderMale.checked = settings.voiceGender === 'male';
  if (voiceGenderFemale) voiceGenderFemale.checked = settings.voiceGender === 'female';
  if (soundMeterToggle) soundMeterToggle.checked = settings.soundMeterEnabled;
  applySoundMeterVisibility(settings.soundMeterEnabled);

  if (openrouterKeyInput && localStorage.getItem('jarvis_openrouter_api_key')) {
    openrouterKeyInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (deepgramKeyInput && localStorage.getItem('jarvis_deepgram_api_key')) {
    deepgramKeyInput.placeholder = '••••••••••••••••• (saved)';
  }

  const openModal = () => settingsModal.classList.add('open');
  const closeModal = () => settingsModal.classList.remove('open');

  settingsBtn.addEventListener('click', openModal);
  if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeModal);
  if (settingsBackdrop) settingsBackdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal.classList.contains('open')) closeModal();
  });

  if (openTabToggle) {
    openTabToggle.addEventListener('change', () => {
      saveSettings({ openTabOnSearch: openTabToggle.checked });
    });
  }

  const applyVoiceGender = (gender) => {
    saveSettings({ voiceGender: gender });
    if (voiceEngine) voiceEngine.applyVoicePreference();
  };
  if (voiceGenderMale) {
    voiceGenderMale.addEventListener('change', () => {
      if (voiceGenderMale.checked) applyVoiceGender('male');
    });
  }
  if (voiceGenderFemale) {
    voiceGenderFemale.addEventListener('change', () => {
      if (voiceGenderFemale.checked) applyVoiceGender('female');
    });
  }

  if (soundMeterToggle) {
    soundMeterToggle.addEventListener('change', () => {
      saveSettings({ soundMeterEnabled: soundMeterToggle.checked });
      applySoundMeterVisibility(soundMeterToggle.checked);
    });
  }

  if (apiKeysSaveBtn) {
    apiKeysSaveBtn.addEventListener('click', () => {
      const openrouterKey = openrouterKeyInput ? openrouterKeyInput.value.trim() : '';
      const deepgramKey = deepgramKeyInput ? deepgramKeyInput.value.trim() : '';

      if (openrouterKey) {
        localStorage.setItem('jarvis_openrouter_api_key', openrouterKey);
        if (jarvis) jarvis.openRouter.apiKey = openrouterKey;
        openrouterKeyInput.value = '';
        openrouterKeyInput.placeholder = '••••••••••••••••• (saved)';
      }
      if (deepgramKey) {
        localStorage.setItem('jarvis_deepgram_api_key', deepgramKey);
        if (voiceEngine) voiceEngine.deepgramApiKey = deepgramKey;
        deepgramKeyInput.value = '';
        deepgramKeyInput.placeholder = '••••••••••••••••• (saved)';
      }

      if (apiKeysStatus) {
        if (openrouterKey || deepgramKey) {
          apiKeysStatus.textContent = '✅ Saved.';
          apiKeysStatus.style.color = '#39ff14';
        } else {
          apiKeysStatus.textContent = 'Enter at least one key to save.';
          apiKeysStatus.style.color = 'var(--text-dim)';
        }
      }
    });
  }
}
```

Then, inside `initApp()`, call it once `jarvis` and `voiceEngine` both exist —
right after the Steam credential setup block (step 8 in the existing
numbered comments) and before the "Voice & Mute Control Handlers" block, add:

```javascript
  // 8b. Settings Panel (general prefs, voice gender, sound meter, API keys)
  initSettingsPanel();
```

- [ ] **Step 9: Checkpoint**

No git repo — nothing to run yet (verified end-to-end in Task 6). Re-read the
diffs in `index.html`, `src/main.js`, and `src/styles.css` once to confirm
every `id` referenced in `main.js` (`settingsBtn`, `settingsModal`,
`settingsBackdrop`, `settingsCloseBtn`, `openTabToggle`, `voiceGenderMale`,
`voiceGenderFemale`, `soundMeterToggle`, `openrouterKeyInput`,
`deepgramKeyInput`, `apiKeysSaveBtn`, `apiKeysStatus`, `speechMeter`) exists
in the `index.html` markup added in Steps 1-3.

---

## Task 6: README, `.env.example`, and manual verification

**Files:**
- Create: `README.md`
- Create: `.env.example`

- [ ] **Step 1: Create `.env.example`**

```bash
# JARVIS voice AI — environment variables (all optional at build time; every
# key below can also be entered later from the in-app ⚙️ Settings panel,
# except Steam, which has its own dedicated panel in the left sidebar).
#
# Copy this file to .env and fill in what you have. Anything left blank just
# means that feature falls back gracefully: no OpenRouter key => local
# knowledge-base answers only; no Deepgram key => free browser/Windows speech
# recognition instead of Deepgram's; no Steam keys => can't launch games by
# name from your real library (a small built-in game list still works).

# Recommended — powers all conversational answers via OpenRouter's free model
# pool. Get one at https://openrouter.ai/keys
VITE_OPENROUTER_API_KEY=

# Optional — upgrades speech-to-text accuracy via Deepgram's streaming API.
# Get one at https://console.deepgram.com
VITE_DEEPGRAM_API_KEY=

# Optional — enables "launch <game>" by name from your real Steam library.
# Get an API key at https://steamcommunity.com/dev/apikey
VITE_STEAM_API_KEY=

# Your 17-digit SteamID64. Find it at https://steamid.io
VITE_STEAM_ID=
```

- [ ] **Step 2: Create `README.md`**

```markdown
# J.A.R.V.I.S. Voice AI

A desktop voice assistant with wake-word listening ("Jarvis" / "Hey Jarvis"),
OpenRouter-powered conversation, Google search automation, and a Steam game
launcher — built as an Electron app with a HUD-style web UI.

## Setup

    npm install

### API keys

JARVIS works with zero configuration (it falls back to a small local
knowledge base and your OS's built-in speech recognition), but for full
functionality you'll want at least an OpenRouter key. There are two ways to
provide keys:

1. **In-app (recommended)** — run the app, click **⚙️ SETTINGS** in the
   header, and paste keys into the API Keys section. Stored in the browser's
   localStorage; nothing leaves your machine except calls to the providers
   themselves.
2. **`.env` file** (baked in at build time):

       cp .env.example .env

   then fill in the values.

| Key | Required? | Get one at |
|---|---|---|
| `VITE_OPENROUTER_API_KEY` | Recommended — powers all conversational answers | https://openrouter.ai/keys |
| `VITE_DEEPGRAM_API_KEY` | Optional — better speech recognition | https://console.deepgram.com |
| `VITE_STEAM_API_KEY` + `VITE_STEAM_ID` | Optional — launch games from your real library by name | https://steamcommunity.com/dev/apikey and https://steamid.io |

Steam credentials have their own setup box in the left panel of the app —
same idea, paste and save, no `.env` required.

## Running it

Dev mode needs two terminals — Vite serves the UI, Electron just points a
window at it:

    npm run dev        # terminal 1 — Vite dev server on localhost:3000
    npm run electron   # terminal 2 — opens the JARVIS window/tray

Or skip Electron and just open `http://localhost:3000` in Chrome/Edge —
everything works there too, except the Windows-speech-recognition bridge and
tray icon (the browser's own SpeechRecognition API is used instead).

## Building an installer

    npm run electron:build

Produces a Windows installer in `release/`.

## Tests

    npm test

Runs the `node --test` suite in `test/` — headless, no API keys or running
app required.
```

- [ ] **Step 3: Run the full automated test suite**

Run: `npm test`
Expected: PASS — 10 tests, 0 failures (4 conversation-memory + 4 settings + 2
jarvis-core-settings).

- [ ] **Step 4: Manually verify the Settings panel end-to-end**

Run: `npm run dev` (leave it running), then open `http://localhost:3000` in a
browser (Electron isn't required for this check — everything below works in
a plain browser tab too).

Check, in order:
1. Click **⚙️ SETTINGS** in the header — modal opens over a dimmed backdrop.
2. Toggle "Open browser tab when searching Google" off, close the modal
   (✕, backdrop click, and Esc should all close it), reopen it — the toggle
   is still off (persisted).
3. Type something like "search google for octopus facts" into the text
   input and press Execute — no new browser tab should open (confirms the
   wiring from Task 3), and the HUD viewport on the right should still show
   the search.
4. Switch the toggle back on, repeat — a new tab should open this time.
5. Switch voice gender to Female, then type any question and press Execute —
   JARVIS's spoken answer should audibly use a different voice than before
   (exact voice depends on what's installed on the OS/browser).
6. With the sound meter toggle on, ask JARVIS a question — the bar row near
   the arc reactor should light up while it's speaking and settle back to
   flat when it finishes. Toggle the meter off and confirm the row
   disappears entirely (even mid-speech, on the next toggle).
7. Paste a real OpenRouter key into the API Keys section and click
   **SAVE KEYS** — the field clears and shows the "(saved)" placeholder;
   `apiKeysStatus` shows "✅ Saved."; a subsequent question should now get a
   real LLM answer instead of the local knowledge-base fallback, with no
   page reload.

- [ ] **Step 5: Checkpoint**

No git repo — this is the final task. Confirm Step 3's automated PASS output
and Step 4's manual checklist both succeeded before considering the feature
done.
