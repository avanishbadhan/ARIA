# Groq LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Groq (`llama-3.1-8b-instant`, faster than OpenRouter's free pool) as a switchable second LLM provider, with its own API key slot and a Settings toggle.

**Architecture:** Extract the JARVIS persona prompt (`src/llm-persona.js`) and the model-queue retry loop (`src/llm-completion.js`) out of `OpenRouterClient` so `GroqClient` can reuse both instead of duplicating ~60 lines. `JarvisCore` gets a `_chatWithActiveLLM()` helper that tries Groq first when the `useGroq` setting is on, falling back to OpenRouter (then the existing local-knowledge-base fallback) on any failure.

**Tech Stack:** Vanilla JS (ES modules), `node --test`. No new dependencies.

**Note on version control:** No git repository in this project (confirmed earlier). "Checkpoint" steps replace "Commit" steps — verify, then move on.

---

## File Structure

- **Create** `src/llm-persona.js` — shared system prompt + `buildJarvisMessages()`.
- **Create** `src/llm-completion.js` — shared `fetchChatCompletion()` retry loop.
- **Create** `src/groq-client.js` — `GroqClient`.
- **Modify** `src/openrouter-client.js` — refactor to use the two new shared modules (behavior-preserving).
- **Modify** `src/settings.js` — add `useGroq: false` to `DEFAULT_SETTINGS`.
- **Modify** `src/jarvis-core.js` — instantiate `GroqClient`, add `_chatWithActiveLLM()`, use it at both existing `chatWithJarvis` call sites.
- **Modify** `index.html` — Groq API key input + `useGroq` switch in the Settings modal.
- **Modify** `src/main.js` — wire the new switch/input into `initSettingsPanel()`.
- **Modify** `.env.example`, `README.md` — document `VITE_GROQ_API_KEY`.
- **Create** `test/llm-persona.test.js`, `test/jarvis-core.llm-provider.test.js`.

---

## Task 1: Extract shared persona + completion-loop modules

**Files:**
- Create: `src/llm-persona.js`
- Test: `test/llm-persona.test.js`
- Create: `src/llm-completion.js`
- Modify: `src/openrouter-client.js` (full rewrite, behavior-preserving)

- [ ] **Step 1: Write the failing test for `buildJarvisMessages`**

```javascript
// test/llm-persona.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJarvisMessages } from '../src/llm-persona.js';

test('buildJarvisMessages puts a system prompt first and the user message last', () => {
  const messages = buildJarvisMessages('What time is it?', []);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /J\.A\.R\.V\.I\.S/);
  assert.deepEqual(messages.at(-1), { role: 'user', content: 'What time is it?' });
});

test('buildJarvisMessages includes prior context between the system and user messages', () => {
  const context = [
    { role: 'user', content: 'Who created Python?' },
    { role: 'assistant', content: 'Guido van Rossum, Sir.' }
  ];
  const messages = buildJarvisMessages('When?', context);
  assert.equal(messages.length, 4); // system + 2 context + user
  assert.deepEqual(messages[1], context[0]);
  assert.deepEqual(messages[2], context[1]);
});

test('buildJarvisMessages keeps only the last 6 context entries', () => {
  const context = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const messages = buildJarvisMessages('latest question', context);
  assert.equal(messages.length, 8); // system + 6 context + user
  assert.equal(messages[1].content, 'msg 4'); // last 6 of 10 = indices 4..9
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/llm-persona.test.js"`
Expected: FAIL — `Cannot find module '../src/llm-persona.js'`.

- [ ] **Step 3: Create `src/llm-persona.js`**

```javascript
// src/llm-persona.js
/**
 * Shared JARVIS persona system prompt and message-array construction, used
 * by every LLM provider client so the persona only exists in one place.
 */
const JARVIS_SYSTEM_PROMPT = `You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), Tony Stark's AI assistant.
Rules:
- Respond in 1-3 sentences maximum. Be concise.
- Address the user as "Sir".
- Never say things like "Searching...", "Let me look that up", "According to my search", or "Check your browser".
- Never use markdown, bullet points, or formatting — your response is read aloud by voice synthesis.
- Speak with quiet confidence. Give the answer directly.`;

export function buildJarvisMessages(userInput, context = []) {
  return [
    { role: 'system', content: JARVIS_SYSTEM_PROMPT },
    ...context.slice(-6), // keep last 6 turns for context
    { role: 'user', content: userInput }
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test "test/llm-persona.test.js"`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Create `src/llm-completion.js` (no dedicated unit test — it wraps `fetch`, exercised indirectly through the two clients' existing manual/log-based verification, matching how `generateCompletion` was never unit-tested before this refactor either)**

```javascript
// src/llm-completion.js
/**
 * Shared OpenAI-compatible chat-completion loop: cycles through a provider's
 * modelQueue on failure (rate limit, outage, empty response) until one
 * succeeds or the queue is exhausted. Used by both OpenRouterClient and
 * GroqClient, which only differ in baseUrl/headers/modelQueue/logPrefix.
 */
export async function fetchChatCompletion({ baseUrl, headers, modelQueue, messages, onLog = () => {}, logPrefix }) {
  let lastError = null;
  for (const model of modelQueue) {
    try {
      onLog({ type: 'HARNESS', message: `[${logPrefix}] Trying model: ${model}` });

      const response = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          max_tokens: 350
        })
      });

      const data = await response.json();

      if (!response.ok) {
        const errMsg = data?.error?.message || `HTTP ${response.status}`;
        onLog({ type: 'WARNING', message: `[${logPrefix}] ${model} failed: ${errMsg}. Trying next model...` });
        lastError = new Error(errMsg);
        continue;
      }

      if (data.choices?.[0]?.message?.content) {
        onLog({ type: 'SUCCESS', message: `[${logPrefix}] Response from ${model}` });
        return data.choices[0].message.content.trim();
      }

      lastError = new Error("Empty completion returned.");
    } catch (e) {
      lastError = e;
      onLog({ type: 'WARNING', message: `[${logPrefix}] Network error on ${model}: ${e.message}` });
    }
  }

  throw lastError || new Error(`All ${logPrefix} models exhausted.`);
}
```

- [ ] **Step 6: Rewrite `src/openrouter-client.js` to use both shared modules**

Replace the entire file content with:

```javascript
// src/openrouter-client.js
/**
 * OpenRouter AI Client for JARVIS
 * Routes conversational requests through OpenRouter's free model pool with
 * automatic failover across verified working free endpoints.
 */

import { fetchChatCompletion } from './llm-completion.js';
import { buildJarvisMessages } from './llm-persona.js';

export class OpenRouterClient {
  constructor(apiKey = '', options = {}) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://openrouter.ai/api/v1/chat/completions';
    this.onLog = options.onLog || (() => {});

    // Ordered list of verified working free models (as of Aug 2026)
    // openrouter/free = OpenRouter's own dynamic free model router (best first-try)
    this.modelQueue = [
      'openrouter/free',
      'nvidia/nemotron-nano-9b-v2:free',
      'nvidia/nemotron-nano-12b-v2-vl:free',
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-super-120b-a12b:free'
    ];
  }

  /**
   * Attempts chat completion cycling through the model queue on failure.
   */
  async generateCompletion(messages) {
    if (!this.apiKey) throw new Error("OpenRouter API Key not configured.");

    return fetchChatCompletion({
      baseUrl: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': window.location.origin || 'http://localhost:3000',
        'X-Title': 'JARVIS Voice AI System'
      },
      modelQueue: this.modelQueue,
      messages,
      onLog: this.onLog,
      logPrefix: 'OPENROUTER'
    });
  }

  /**
   * Generates a JARVIS-persona voice response for the given user input.
   */
  async chatWithJarvis(userInput, context = []) {
    try {
      return await this.generateCompletion(buildJarvisMessages(userInput, context));
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[OPENROUTER FALLBACK] ${err.message}` });
      return null; // null triggers local knowledge base fallback in JarvisCore
    }
  }
}
```

- [ ] **Step 7: Run the full test suite to confirm nothing broke**

Run: `node --test "test/**/*.test.js"`
Expected: PASS — 13 tests total (10 existing + 3 new `llm-persona` tests), 0
failures. (`OpenRouterClient` isn't imported by any existing test directly,
but `JarvisCore` constructs one, so this also indirectly confirms the
rewrite doesn't break construction.)

- [ ] **Step 8: Checkpoint**

No git repo — confirm the 13-test PASS output above before moving on.

---

## Task 2: `GroqClient`

**Files:**
- Create: `src/groq-client.js`

No dedicated unit test — same reasoning as `llm-completion.js` in Task 1;
this class is a thin config wrapper around already-tested/shared logic.
Covered indirectly by Task 4's `jarvis-core` provider-switching tests, which
stub `chatWithJarvis` directly.

- [ ] **Step 1: Create `src/groq-client.js`**

```javascript
// src/groq-client.js
/**
 * Groq AI Client for JARVIS
 * Routes conversational requests through Groq's low-latency inference API —
 * much faster than OpenRouter's free pool for basic conversation, at the
 * cost of a smaller/less capable default model.
 */

import { fetchChatCompletion } from './llm-completion.js';
import { buildJarvisMessages } from './llm-persona.js';

export class GroqClient {
  constructor(apiKey = '', options = {}) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.groq.com/openai/v1/chat/completions';
    this.onLog = options.onLog || (() => {});

    // llama-3.1-8b-instant first for speed; 70B fallback if it's rate-limited/unavailable.
    this.modelQueue = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];
  }

  /**
   * Attempts chat completion cycling through the model queue on failure.
   */
  async generateCompletion(messages) {
    if (!this.apiKey) throw new Error("Groq API Key not configured.");

    return fetchChatCompletion({
      baseUrl: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      modelQueue: this.modelQueue,
      messages,
      onLog: this.onLog,
      logPrefix: 'GROQ'
    });
  }

  /**
   * Generates a JARVIS-persona voice response for the given user input.
   */
  async chatWithJarvis(userInput, context = []) {
    try {
      return await this.generateCompletion(buildJarvisMessages(userInput, context));
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[GROQ FALLBACK] ${err.message}` });
      return null; // null triggers OpenRouter fallback in JarvisCore
    }
  }
}
```

- [ ] **Step 2: Run the full test suite to confirm nothing broke**

Run: `node --test "test/**/*.test.js"`
Expected: PASS — 13 tests, 0 failures (no new tests yet; `GroqClient` isn't
imported by anything until Task 3).

- [ ] **Step 3: Checkpoint**

No git repo — confirm the PASS output above before moving on.

---

## Task 3: `useGroq` setting

**Files:**
- Modify: `src/settings.js:14-18`

- [ ] **Step 1: Add `useGroq` to `DEFAULT_SETTINGS`**

In `src/settings.js`, change:

```javascript
export const DEFAULT_SETTINGS = {
  openTabOnSearch: true,
  voiceGender: 'male',
  soundMeterEnabled: true
};
```

to:

```javascript
export const DEFAULT_SETTINGS = {
  openTabOnSearch: true,
  voiceGender: 'male',
  soundMeterEnabled: true,
  useGroq: false
};
```

- [ ] **Step 2: Run the settings test suite to confirm nothing broke**

Run: `node --test "test/settings.test.js"`
Expected: PASS — 4 tests, 0 failures (the existing `deepEqual` assertions
against `DEFAULT_SETTINGS` compare against the live export, so they still
pass with the new key present on both sides).

- [ ] **Step 3: Checkpoint**

No git repo — confirm the PASS output above before moving on.

---

## Task 4: Wire the provider switch into `JarvisCore`

**Files:**
- Test: `test/jarvis-core.llm-provider.test.js`
- Modify: `src/jarvis-core.js:7-31` (imports + constructor), and the two
  `chatWithJarvis` call sites (Google-search branch and the main
  conversational branch)

- [ ] **Step 1: Write the failing tests**

```javascript
// test/jarvis-core.llm-provider.test.js
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('useGroq false (default): only OpenRouter is called', async () => {
  const jarvis = createJarvis();
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return 'should not be used';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.groqCalls.length, 0, 'Groq must not be called when useGroq is off');
  assert.equal(jarvis.llmCalls.length, 1, 'OpenRouter handled the request');
});

test('useGroq true and Groq succeeds: OpenRouter is never called', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return 'groq answer';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.groqCalls.length, 1);
  assert.equal(jarvis.llmCalls.length, 0, 'OpenRouter must not be called when Groq already answered');
});

test('useGroq true and Groq fails: falls through to OpenRouter', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return null; // simulates missing key / rate limit / network error
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.groqCalls.length, 1);
  assert.equal(jarvis.llmCalls.length, 1, 'OpenRouter picks up the request after Groq returns null');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/jarvis-core.llm-provider.test.js"`
Expected: FAIL on all 3 — `jarvis.groq` is `undefined` (`GroqClient` isn't
instantiated in `JarvisCore` yet), so `jarvis.groq.chatWithJarvis = ...`
throws a `TypeError`.

- [ ] **Step 3: Import `GroqClient` and instantiate it in the constructor**

In `src/jarvis-core.js`, change:

```javascript
import { SteamHarness } from './steam-harness.js';
import { AutonomousToolReasoner } from './autonomous-tool-reasoner.js';
import { OpenRouterClient } from './openrouter-client.js';
import { loadSettings } from './settings.js';
```

to:

```javascript
import { SteamHarness } from './steam-harness.js';
import { AutonomousToolReasoner } from './autonomous-tool-reasoner.js';
import { OpenRouterClient } from './openrouter-client.js';
import { GroqClient } from './groq-client.js';
import { loadSettings } from './settings.js';
```

Then, right after the existing `this.openRouter = new OpenRouterClient(...)`
block:

```javascript
    this.openRouter = new OpenRouterClient(openRouterApiKey, {
      onLog: (logData) => this.onLog(logData)
    });
```

add:

```javascript

    // Instantiate Groq Client (optional — faster alternative to OpenRouter,
    // toggled via the useGroq setting)
    const groqApiKey = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GROQ_API_KEY)
      || localStorage.getItem('jarvis_groq_api_key')
      || '';
    this.groq = new GroqClient(groqApiKey, {
      onLog: (logData) => this.onLog(logData)
    });
```

- [ ] **Step 4: Add `_chatWithActiveLLM()`**

In `src/jarvis-core.js`, add this method right before `_pushHistory`:

```javascript
  /**
   * Routes a conversational request to the currently-selected LLM provider.
   * If useGroq is on but Groq returns nothing (no key, rate limit, network
   * error), falls through to OpenRouter — which itself falls through to the
   * local knowledge base in processUserInput if it also returns nothing.
   */
  async _chatWithActiveLLM(userInput, context) {
    if (loadSettings().useGroq) {
      const groqAnswer = await this.groq.chatWithJarvis(userInput, context);
      if (groqAnswer) return groqAnswer;
    }
    return this.openRouter.chatWithJarvis(userInput, context);
  }
```

- [ ] **Step 5: Use it at both existing call sites**

In the Google-search branch, change:

```javascript
      const [searchResult, llmAnswer] = await Promise.all([
        this.harness.executeGoogleSearch(decision.params.query, loadSettings().openTabOnSearch),
        this.openRouter.chatWithJarvis(
          `Answer this question briefly in 2-3 sentences. Do not say you're searching or mention any browser. Just give the answer clearly: ${decision.params.query}`,
          this.conversationHistory
        )
      ]);
```

to:

```javascript
      const [searchResult, llmAnswer] = await Promise.all([
        this.harness.executeGoogleSearch(decision.params.query, loadSettings().openTabOnSearch),
        this._chatWithActiveLLM(
          `Answer this question briefly in 2-3 sentences. Do not say you're searching or mention any browser. Just give the answer clearly: ${decision.params.query}`,
          this.conversationHistory
        )
      ]);
```

In the main conversational branch, change:

```javascript
    let answerText = await this.openRouter.chatWithJarvis(input, this.conversationHistory);
```

to:

```javascript
    let answerText = await this._chatWithActiveLLM(input, this.conversationHistory);
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `node --test "test/jarvis-core.llm-provider.test.js"`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 7: Run the full suite to confirm nothing broke**

Run: `node --test "test/**/*.test.js"`
Expected: PASS — 16 tests total (13 from Task 1 + 3 new), 0 failures. This
also re-confirms the existing conversation-memory and openTabOnSearch tests
still pass unchanged, since `useGroq` defaults to `false` and
`_chatWithActiveLLM` degrades to exactly the old `openRouter.chatWithJarvis`
call in that case.

- [ ] **Step 8: Checkpoint**

No git repo — confirm the 16-test PASS output above before moving on.

---

## Task 5: Settings UI — Groq key + switch

**Files:**
- Modify: `index.html`
- Modify: `src/main.js`

No automated test — DOM wiring, same reasoning as the earlier Settings
modal work. Verify manually per Task 6.

- [ ] **Step 1: Add the `useGroq` switch and Groq key field to the modal markup**

In `index.html`, the General section currently reads:

```html
      <div class="settings-section">
        <div class="settings-section-title">General</div>
        <label class="settings-row">
          <span>Open browser tab when searching Google</span>
          <input type="checkbox" id="openTabToggle" class="settings-switch" />
        </label>
      </div>
```

Change it to:

```html
      <div class="settings-section">
        <div class="settings-section-title">General</div>
        <label class="settings-row">
          <span>Open browser tab when searching Google</span>
          <input type="checkbox" id="openTabToggle" class="settings-switch" />
        </label>
        <label class="settings-row">
          <span>Use Groq (faster) instead of OpenRouter</span>
          <input type="checkbox" id="useGroqToggle" class="settings-switch" />
        </label>
      </div>
```

Then, in the API Keys section, change:

```html
        <input type="password" id="openrouterKeyInput" class="steam-input" placeholder="OpenRouter API Key" autocomplete="off" />
        <input type="password" id="deepgramKeyInput" class="steam-input" placeholder="Deepgram API Key (optional)" autocomplete="off" />
        <div class="settings-hint">Restart JARVIS after adding/changing the Deepgram key to activate it.</div>
```

to:

```html
        <input type="password" id="openrouterKeyInput" class="steam-input" placeholder="OpenRouter API Key" autocomplete="off" />
        <input type="password" id="groqKeyInput" class="steam-input" placeholder="Groq API Key (optional, get one at console.groq.com/keys)" autocomplete="off" />
        <input type="password" id="deepgramKeyInput" class="steam-input" placeholder="Deepgram API Key (optional)" autocomplete="off" />
        <div class="settings-hint">Restart JARVIS after adding/changing the Deepgram key to activate it.</div>
```

Also update the hint line just above (currently links only OpenRouter +
Deepgram) — change:

```html
        <div class="settings-hint">
          <a href="https://openrouter.ai/keys" target="_blank">Get an OpenRouter key</a>
          (required for conversational answers) ·
          <a href="https://console.deepgram.com" target="_blank">Get a Deepgram key</a>
          (optional, improves speech recognition)
        </div>
```

to:

```html
        <div class="settings-hint">
          <a href="https://openrouter.ai/keys" target="_blank">Get an OpenRouter key</a>
          (required for conversational answers) ·
          <a href="https://console.groq.com/keys" target="_blank">Get a Groq key</a>
          (optional, much faster responses) ·
          <a href="https://console.deepgram.com" target="_blank">Get a Deepgram key</a>
          (optional, improves speech recognition)
        </div>
```

- [ ] **Step 2: Wire it up in `initSettingsPanel()`**

In `src/main.js`, inside `initSettingsPanel()`, add two new DOM refs
alongside the existing ones:

```javascript
  const useGroqToggle = document.getElementById('useGroqToggle');
  const groqKeyInput = document.getElementById('groqKeyInput');
```

Set its initial state alongside the other toggles:

```javascript
  if (soundMeterToggle) soundMeterToggle.checked = settings.soundMeterEnabled;
```

becomes:

```javascript
  if (soundMeterToggle) soundMeterToggle.checked = settings.soundMeterEnabled;
  if (useGroqToggle) useGroqToggle.checked = settings.useGroq;
```

Pre-fill the "(saved)" placeholder alongside the OpenRouter/Deepgram checks:

```javascript
  if (openrouterKeyInput && localStorage.getItem('jarvis_openrouter_api_key')) {
    openrouterKeyInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (deepgramKeyInput && localStorage.getItem('jarvis_deepgram_api_key')) {
    deepgramKeyInput.placeholder = '••••••••••••••••• (saved)';
  }
```

becomes:

```javascript
  if (openrouterKeyInput && localStorage.getItem('jarvis_openrouter_api_key')) {
    openrouterKeyInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (groqKeyInput && localStorage.getItem('jarvis_groq_api_key')) {
    groqKeyInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (deepgramKeyInput && localStorage.getItem('jarvis_deepgram_api_key')) {
    deepgramKeyInput.placeholder = '••••••••••••••••• (saved)';
  }
```

Add the change listener alongside the `soundMeterToggle` one:

```javascript
  if (soundMeterToggle) {
    soundMeterToggle.addEventListener('change', () => {
      saveSettings({ soundMeterEnabled: soundMeterToggle.checked });
      applySoundMeterVisibility(soundMeterToggle.checked);
    });
  }
```

becomes:

```javascript
  if (soundMeterToggle) {
    soundMeterToggle.addEventListener('change', () => {
      saveSettings({ soundMeterEnabled: soundMeterToggle.checked });
      applySoundMeterVisibility(soundMeterToggle.checked);
    });
  }

  if (useGroqToggle) {
    useGroqToggle.addEventListener('change', () => {
      saveSettings({ useGroq: useGroqToggle.checked });
    });
  }
```

Finally, extend the API-keys save handler. Change:

```javascript
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
```

to:

```javascript
      const openrouterKey = openrouterKeyInput ? openrouterKeyInput.value.trim() : '';
      const groqKey = groqKeyInput ? groqKeyInput.value.trim() : '';
      const deepgramKey = deepgramKeyInput ? deepgramKeyInput.value.trim() : '';

      if (openrouterKey) {
        localStorage.setItem('jarvis_openrouter_api_key', openrouterKey);
        if (jarvis) jarvis.openRouter.apiKey = openrouterKey;
        openrouterKeyInput.value = '';
        openrouterKeyInput.placeholder = '••••••••••••••••• (saved)';
      }
      if (groqKey) {
        localStorage.setItem('jarvis_groq_api_key', groqKey);
        if (jarvis) jarvis.groq.apiKey = groqKey;
        groqKeyInput.value = '';
        groqKeyInput.placeholder = '••••••••••••••••• (saved)';
      }
      if (deepgramKey) {
        localStorage.setItem('jarvis_deepgram_api_key', deepgramKey);
        if (voiceEngine) voiceEngine.deepgramApiKey = deepgramKey;
        deepgramKeyInput.value = '';
        deepgramKeyInput.placeholder = '••••••••••••••••• (saved)';
      }

      if (apiKeysStatus) {
        if (openrouterKey || groqKey || deepgramKey) {
          apiKeysStatus.textContent = '✅ Saved.';
          apiKeysStatus.style.color = '#39ff14';
        } else {
          apiKeysStatus.textContent = 'Enter at least one key to save.';
          apiKeysStatus.style.color = 'var(--text-dim)';
        }
      }
```

- [ ] **Step 3: Run the full test suite to confirm nothing broke**

Run: `node --test "test/**/*.test.js"`
Expected: PASS — 16 tests, 0 failures.

- [ ] **Step 4: Checkpoint**

No git repo — confirm every new `id` referenced in `main.js`
(`useGroqToggle`, `groqKeyInput`) exists in `index.html` before moving on
(same cross-check style as the earlier Settings-panel work).

---

## Task 6: Docs

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add `VITE_GROQ_API_KEY` to `.env.example`**

Change:

```bash
# Optional — upgrades speech-to-text accuracy via Deepgram's streaming API.
# Get one at https://console.deepgram.com
VITE_DEEPGRAM_API_KEY=
```

to (inserting the Groq block before Deepgram, matching the OpenRouter →
Groq → Deepgram order used in the Settings UI):

```bash
# Optional — much faster responses than OpenRouter's free pool via Groq's
# low-latency inference (llama-3.1-8b-instant). Get one at
# https://console.groq.com/keys
VITE_GROQ_API_KEY=

# Optional — upgrades speech-to-text accuracy via Deepgram's streaming API.
# Get one at https://console.deepgram.com
VITE_DEEPGRAM_API_KEY=
```

- [ ] **Step 2: Add a row to the `README.md` API keys table**

Change:

```markdown
| Key | Required? | Get one at |
|---|---|---|
| `VITE_OPENROUTER_API_KEY` | Recommended — powers all conversational answers | https://openrouter.ai/keys |
| `VITE_DEEPGRAM_API_KEY` | Optional — better speech recognition | https://console.deepgram.com |
| `VITE_STEAM_API_KEY` + `VITE_STEAM_ID` | Optional — launch games from your real library by name | https://steamcommunity.com/dev/apikey and https://steamid.io |
```

to:

```markdown
| Key | Required? | Get one at |
|---|---|---|
| `VITE_OPENROUTER_API_KEY` | Recommended — powers all conversational answers | https://openrouter.ai/keys |
| `VITE_GROQ_API_KEY` | Optional — much faster responses (toggle in Settings) | https://console.groq.com/keys |
| `VITE_DEEPGRAM_API_KEY` | Optional — better speech recognition | https://console.deepgram.com |
| `VITE_STEAM_API_KEY` + `VITE_STEAM_ID` | Optional — launch games from your real library by name | https://steamcommunity.com/dev/apikey and https://steamid.io |
```

Also, in the "Settings" section's bullet list, add a line after the API Keys
bullet:

```markdown
- **API Keys** — OpenRouter and Deepgram, as described above. OpenRouter
  changes apply immediately; a newly added Deepgram key requires restarting
  JARVIS to take effect.
```

becomes:

```markdown
- **API Keys** — OpenRouter, Groq, and Deepgram, as described above.
  OpenRouter and Groq key changes apply immediately; a newly added Deepgram
  key requires restarting JARVIS to take effect.
- **Use Groq instead of OpenRouter** — Y/N. Groq's `llama-3.1-8b-instant` is
  much faster than OpenRouter's free model pool. If Groq fails (no key set,
  rate-limited, network error), JARVIS automatically falls back to
  OpenRouter, then to the local knowledge base — same as always.
```

- [ ] **Step 3: Checkpoint**

No git repo — this is a docs-only task, nothing to run. Read both files back
once to confirm the edits landed cleanly.

---

## Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated suite**

Run: `npm test`
Expected: PASS — 16 tests, 0 failures.

- [ ] **Step 2: Manually verify in a browser**

With `npm run dev` running, open the app and:
1. Open Settings — confirm the new "Use Groq" switch and "Groq API Key"
   field appear, and the switch is off by default.
2. Paste a real Groq key, save, confirm "(saved)" placeholder appears.
3. Flip "Use Groq" on, close the modal, ask JARVIS a question — response
   should arrive noticeably faster than before, and the terminal console
   should log `[GROQ] Trying model: llama-3.1-8b-instant` /
   `[GROQ] Response from llama-3.1-8b-instant`.
4. Flip "Use Groq" off, ask another question — console should show
   `[OPENROUTER]` logs instead, confirming the switch actually changes
   behavior live with no reload.

- [ ] **Step 3: Checkpoint**

No git repo — this is the final task. Confirm Step 1's automated PASS output
and Step 2's manual checklist both succeeded before considering the feature
done.
