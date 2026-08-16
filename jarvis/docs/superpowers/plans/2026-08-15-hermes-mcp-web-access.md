# Hermes Provider & MCP Web Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hermes (Nous Research, via OpenRouter) as a selectable LLM provider, and replace `web_search`'s thin DuckDuckGo/Wikipedia lookup with real webpage reading via a single curated MCP server (Playwright MCP), plus a new `browse_webpage` grounding tool — available to any active provider, not just Hermes.

**Architecture:** Hermes reuses `OpenRouterClient`'s transport/API key with a separate pinned model queue, selected via a new `useHermes` Settings toggle mirroring the existing `useGroq` pattern. Playwright MCP runs as a child process spawned by `electron/main.cjs` (the same "main process owns all external calls" boundary as Gmail/Calendar/Spotify), wrapped by a new `McpWebHarness` on the renderer side following the exact shape of `GmailHarness`/`GoogleCalendarHarness`.

**Tech Stack:** Vanilla JS (ES modules) for the renderer, CommonJS for `electron/`, `@modelcontextprotocol/sdk` (ESM-only, loaded via dynamic `import()` from the `.cjs` main process), `@playwright/mcp`, `node --test`.

**Spec:** `jarvis/docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md`

---

## Task 1: `useHermes` setting

**Files:**
- Modify: `jarvis/src/settings.js:12-18`

- [ ] **Step 1: Add `useHermes` to `DEFAULT_SETTINGS`**

In `jarvis/src/settings.js`, change:

```javascript
export const DEFAULT_SETTINGS = {
  openTabOnSearch: true,
  voiceGender: 'male',
  soundMeterEnabled: true,
  useGroq: false,
  groqModelTier: 'quick'
};
```

to:

```javascript
export const DEFAULT_SETTINGS = {
  openTabOnSearch: true,
  voiceGender: 'male',
  soundMeterEnabled: true,
  useGroq: false,
  groqModelTier: 'quick',
  useHermes: false
};
```

- [ ] **Step 2: Run the settings test suite to confirm nothing broke**

Run: `node --test test/settings.test.js`
Expected: PASS — 4 tests, 0 failures. `test('loadSettings returns defaults when nothing stored', ...)` already does a `deepEqual` against the live `DEFAULT_SETTINGS` export, so it covers the new key automatically — no new test needed for this step.

- [ ] **Step 3: Commit**

```bash
git add jarvis/src/settings.js
git commit -m "Add useHermes setting"
```

---

## Task 2: `OpenRouterClient` model-queue override

**Files:**
- Modify: `jarvis/src/openrouter-client.js:10-30`
- Test: `jarvis/test/openrouter-client.test.js`

- [ ] **Step 1: Write the failing test**

Append to `jarvis/test/openrouter-client.test.js`:

```javascript
test('constructor accepts an explicit modelQueue override, used instead of the default free pool', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'Hermes answer.' } }] });
  const client = new OpenRouterClient('fake-key', { modelQueue: ['nousresearch/hermes-4-405b', 'nousresearch/hermes-4-70b'] });

  assert.deepEqual(client.modelQueue, ['nousresearch/hermes-4-405b', 'nousresearch/hermes-4-70b']);

  await client.generateCompletion([{ role: 'user', content: 'hi' }]);

  assert.equal(calls[0].body.model, 'nousresearch/hermes-4-405b');
});

test('constructor falls back to the default free-model queue when no modelQueue option is given', () => {
  const client = new OpenRouterClient('fake-key');
  assert.equal(client.modelQueue[0], 'openrouter/free');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/openrouter-client.test.js`
Expected: FAIL on the first new test — `client.modelQueue` is the default free-pool array, not the override, since the constructor doesn't read `options.modelQueue` yet.

- [ ] **Step 3: Add the override in the constructor**

In `jarvis/src/openrouter-client.js`, change:

```javascript
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
```

to:

```javascript
  constructor(apiKey = '', options = {}) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://openrouter.ai/api/v1/chat/completions';
    this.onLog = options.onLog || (() => {});

    // Ordered list of verified working free models (as of Aug 2026)
    // openrouter/free = OpenRouter's own dynamic free model router (best first-try)
    // options.modelQueue overrides this — used by JarvisCore to build a
    // second OpenRouterClient instance pinned to Hermes models instead of
    // the free pool (same API key/transport, different queue). See
    // docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md.
    this.modelQueue = options.modelQueue || [
      'openrouter/free',
      'nvidia/nemotron-nano-9b-v2:free',
      'nvidia/nemotron-nano-12b-v2-vl:free',
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-super-120b-a12b:free'
    ];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/openrouter-client.test.js`
Expected: PASS — all tests including the 2 new ones.

- [ ] **Step 5: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: PASS — every existing test file still passes, since `options.modelQueue` defaults to the exact same array as before when omitted.

- [ ] **Step 6: Commit**

```bash
git add jarvis/src/openrouter-client.js jarvis/test/openrouter-client.test.js
git commit -m "Let OpenRouterClient accept a modelQueue override"
```

---

## Task 3: Wire Hermes into `JarvisCore`

**Files:**
- Modify: `jarvis/src/jarvis-core.js` (constructor, `_activeProviderLabel`, `_chatWithActiveLLM`)
- Test: `jarvis/test/jarvis-core.hermes-provider.test.js`
- Modify: `jarvis/test/jarvis-core.active-provider-label.test.js`

Hermes models on OpenRouter are **not free** (Hermes 4 405B: $1/M input, $3/M output tokens) — it reuses the existing OpenRouter API key, so there's no new key to configure, but it does spend OpenRouter credits whenever `useHermes` is on. `nousresearch/hermes-4-405b` is the primary model (flagship, best tool-calling), `nousresearch/hermes-4-70b` (cheaper, same family) is the fallback if the first fails.

- [ ] **Step 1: Write the failing tests**

Create `jarvis/test/jarvis-core.hermes-provider.test.js`:

```javascript
/**
 * Tests Hermes's place in the provider fallback chain: tried first when
 * useHermes is on and a key is configured (ahead of Groq/OpenRouter, since
 * it's the more capable/agentic model for tool-calling), behind Gemini at
 * Ultra tier, falling through to Groq/OpenRouter on failure or no key —
 * mirrors jarvis-core.llm-provider.test.js's Groq/OpenRouter tests.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('useHermes false: Hermes is never called', async () => {
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = 'fake-openrouter-key';
  jarvis.hermesCalls = [];
  jarvis.hermes.chatWithJarvis = async (input) => {
    jarvis.hermesCalls.push(input);
    return 'should not be used';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.hermesCalls.length, 0, 'Hermes must not be called when useHermes is off');
  assert.equal(jarvis.llmCalls.length, 1, 'OpenRouter handled the request');
});

test('useHermes true and Hermes succeeds: Groq and OpenRouter are never called', async () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = 'fake-openrouter-key';
  jarvis.hermesCalls = [];
  jarvis.hermes.chatWithJarvis = async (input) => {
    jarvis.hermesCalls.push(input);
    return 'hermes answer';
  };
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return 'should not be used';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.hermesCalls.length, 1);
  assert.equal(jarvis.groqCalls.length, 0, 'Groq must not be called when Hermes already answered');
  assert.equal(jarvis.llmCalls.length, 0, 'OpenRouter must not be called when Hermes already answered');
});

test('useHermes true and Hermes fails: falls through to the normal Groq/OpenRouter chain', async () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = 'fake-openrouter-key';
  jarvis.hermesCalls = [];
  jarvis.hermes.chatWithJarvis = async (input) => {
    jarvis.hermesCalls.push(input);
    return null; // simulates missing key / rate limit / network error
  };
  jarvis.openRouter.apiKey = 'fake-openrouter-key';

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.hermesCalls.length, 1);
  assert.equal(jarvis.llmCalls.length, 1, 'OpenRouter picks up the request after Hermes returns null');
});

test('useHermes true but no OpenRouter key configured: Hermes is skipped entirely', async () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = ''; // no OpenRouter key configured, so Hermes has none either
  jarvis.hermesCalls = [];
  jarvis.hermes.chatWithJarvis = async (input) => {
    jarvis.hermesCalls.push(input);
    return 'should not be called';
  };
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return 'groq answer';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.hermesCalls.length, 0, 'Hermes is never attempted without a key');
  assert.equal(jarvis.groqCalls.length, 1, 'falls through to Groq instead');
});

test('Ultra tier with a Gemini key takes priority over Hermes', async () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'ultra';
  jarvis.gemini.apiKey = 'fake-gemini-key';
  jarvis.geminiCalls = [];
  jarvis.gemini.chatWithJarvis = async (input) => {
    jarvis.geminiCalls.push(input);
    return 'gemini answer';
  };
  jarvis.hermes.apiKey = 'fake-openrouter-key';
  jarvis.hermesCalls = [];
  jarvis.hermes.chatWithJarvis = async (input) => {
    jarvis.hermesCalls.push(input);
    return 'should not be used';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.geminiCalls.length, 1);
  assert.equal(jarvis.hermesCalls.length, 0, 'Hermes must not be called when Gemini already answered at Ultra tier');
});
```

Append to `jarvis/test/jarvis-core.active-provider-label.test.js`:

```javascript
test('reports Hermes when useHermes is on and a key is configured', () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = 'fake-openrouter-key';

  assert.equal(jarvis._activeProviderLabel(), 'Hermes');
});

test('does not report Hermes when useHermes is on but no key is configured', () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = '';
  jarvis.groq.apiKey = 'fake-groq-key';

  assert.equal(jarvis._activeProviderLabel(), 'Groq');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/jarvis-core.hermes-provider.test.js test/jarvis-core.active-provider-label.test.js`
Expected: FAIL — `jarvis.hermes` is `undefined` (`Cannot read properties of undefined (reading 'apiKey')`), since `JarvisCore` doesn't instantiate a Hermes client yet.

- [ ] **Step 3: Instantiate `this.hermes` in the constructor**

In `jarvis/src/jarvis-core.js`, right after the existing block:

```javascript
    this.openRouter = new OpenRouterClient(openRouterApiKey, {
      onLog: (logData) => this.onLog(logData)
    });
    this.groq = new GroqClient(groqApiKey, {
      onLog: (logData) => this.onLog(logData)
    });
    this.groq.setTier(loadSettings().groqModelTier);
```

add:

```javascript

    // Hermes (Nous Research) — same OpenRouter connection/key as
    // this.openRouter, just a different pinned model queue. NOT part of the
    // free pool (see docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md)
    // — only ever tried when useHermes is explicitly switched on, and every
    // call spends OpenRouter credits. Hermes 4 405B first (best tool-use),
    // Hermes 4 70B (cheaper, same family) as fallback.
    this.hermes = new OpenRouterClient(openRouterApiKey, {
      onLog: (logData) => this.onLog(logData),
      modelQueue: ['nousresearch/hermes-4-405b', 'nousresearch/hermes-4-70b']
    });
```

- [ ] **Step 4: Add the Hermes branch to `_activeProviderLabel()`**

In `jarvis/src/jarvis-core.js`, change:

```javascript
  _activeProviderLabel() {
    if (this.groq.currentTier === 'ultra' && this.gemini.apiKey) return 'Gemini';
    const preferGroq = loadSettings().useGroq || !this.openRouter.apiKey;
    if (preferGroq && this.groq.apiKey) return 'Groq';
    if (this.openRouter.apiKey) return 'OpenRouter';
    return 'local knowledge base';
  }
```

to:

```javascript
  _activeProviderLabel() {
    if (this.groq.currentTier === 'ultra' && this.gemini.apiKey) return 'Gemini';
    if (loadSettings().useHermes && this.hermes.apiKey) return 'Hermes';
    const preferGroq = loadSettings().useGroq || !this.openRouter.apiKey;
    if (preferGroq && this.groq.apiKey) return 'Groq';
    if (this.openRouter.apiKey) return 'OpenRouter';
    return 'local knowledge base';
  }
```

- [ ] **Step 5: Add the Hermes branch to `_chatWithActiveLLM()`**

In `jarvis/src/jarvis-core.js`, change:

```javascript
  async _chatWithActiveLLM(userInput, context, options = {}) {
    // Ultra tier routes to Gemini first, regardless of the Groq/OpenRouter
    // preference below — if it has no key or fails, fall through to the
    // normal Groq/OpenRouter chain exactly as any other tier would.
    let answer;
    if (this.groq.currentTier === 'ultra' && this.gemini.apiKey) {
      answer = await this.gemini.chatWithJarvis(userInput, context, options);
      if (answer) return this._cleanLlmText(answer);
    }

    // Prefer Groq when explicitly switched on, or automatically when
    // OpenRouter has no key configured — this is what makes the OpenRouter
    // key optional as long as a Groq key is set. options.tools/toolExecutor
    // (both optional) pass straight through — see src/jarvis-tools.js.
    // Callers that want a tool-free answer (e.g. the MATH_QUERY fallback,
    // which already has its own dedicated math prompt) simply omit options.
    const preferGroq = loadSettings().useGroq || !this.openRouter.apiKey;
    if (preferGroq) {
      answer = await this.groq.chatWithJarvis(userInput, context, options);
      if (answer) return this._cleanLlmText(answer);
    }
    return this._cleanLlmText(await this.openRouter.chatWithJarvis(userInput, context, options));
  }
```

to:

```javascript
  async _chatWithActiveLLM(userInput, context, options = {}) {
    // Ultra tier routes to Gemini first, regardless of the Hermes/Groq/OpenRouter
    // preference below — if it has no key or fails, fall through to the
    // normal chain exactly as any other tier would.
    let answer;
    if (this.groq.currentTier === 'ultra' && this.gemini.apiKey) {
      answer = await this.gemini.chatWithJarvis(userInput, context, options);
      if (answer) return this._cleanLlmText(answer);
    }

    // Hermes — tried next when explicitly switched on and a key is
    // configured, ahead of the Groq/OpenRouter preference below, since it's
    // the more capable/agentic model for tool-calling (see
    // docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md).
    // Falls through on failure like every other provider.
    if (loadSettings().useHermes && this.hermes.apiKey) {
      answer = await this.hermes.chatWithJarvis(userInput, context, options);
      if (answer) return this._cleanLlmText(answer);
    }

    // Prefer Groq when explicitly switched on, or automatically when
    // OpenRouter has no key configured — this is what makes the OpenRouter
    // key optional as long as a Groq key is set. options.tools/toolExecutor
    // (both optional) pass straight through — see src/jarvis-tools.js.
    // Callers that want a tool-free answer (e.g. the MATH_QUERY fallback,
    // which already has its own dedicated math prompt) simply omit options.
    const preferGroq = loadSettings().useGroq || !this.openRouter.apiKey;
    if (preferGroq) {
      answer = await this.groq.chatWithJarvis(userInput, context, options);
      if (answer) return this._cleanLlmText(answer);
    }
    return this._cleanLlmText(await this.openRouter.chatWithJarvis(userInput, context, options));
  }
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `node --test test/jarvis-core.hermes-provider.test.js test/jarvis-core.active-provider-label.test.js`
Expected: PASS — all tests, including the 5 new Hermes-provider tests and 2 new label tests.

- [ ] **Step 7: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: PASS — every test file, including the existing Groq/OpenRouter/Gemini provider tests, since `useHermes` defaults to `false` and `_chatWithActiveLLM`/`_activeProviderLabel` degrade to their exact prior behavior in that case.

- [ ] **Step 8: Commit**

```bash
git add jarvis/src/jarvis-core.js jarvis/test/jarvis-core.hermes-provider.test.js jarvis/test/jarvis-core.active-provider-label.test.js
git commit -m "Wire Hermes into JarvisCore's provider fallback chain"
```

---

## Task 4: Hermes Settings UI

**Files:**
- Modify: `jarvis/index.html`
- Modify: `jarvis/src/main.js`

No automated test — pure DOM wiring, same reasoning as the existing `useGroqToggle`/`openrouterKeyInput` wiring. Verified manually in Task 11.

- [ ] **Step 1: Add the `useHermes` toggle next to the existing Groq one**

In `jarvis/index.html`, find:

```html
        <label class="settings-row">
          <span>Use Groq (faster) instead of OpenRouter</span>
          <input type="checkbox" id="useGroqToggle" class="settings-switch" />
        </label>
      </div>
```

Change to:

```html
        <label class="settings-row">
          <span>Use Groq (faster) instead of OpenRouter</span>
          <input type="checkbox" id="useGroqToggle" class="settings-switch" />
        </label>
        <label class="settings-row">
          <span>Use Hermes (agentic, paid via OpenRouter credits)</span>
          <input type="checkbox" id="useHermesToggle" class="settings-switch" />
        </label>
      </div>
```

- [ ] **Step 2: Add the DOM ref, initial state, and change listener in `main.js`**

In `jarvis/src/main.js`, change:

```javascript
  const useGroqToggle = document.getElementById('useGroqToggle');
```

to:

```javascript
  const useGroqToggle = document.getElementById('useGroqToggle');
  const useHermesToggle = document.getElementById('useHermesToggle');
```

Change:

```javascript
  if (useGroqToggle) useGroqToggle.checked = settings.useGroq;
```

to:

```javascript
  if (useGroqToggle) useGroqToggle.checked = settings.useGroq;
  if (useHermesToggle) useHermesToggle.checked = settings.useHermes;
```

Change:

```javascript
  if (useGroqToggle) {
    useGroqToggle.addEventListener('change', () => {
      saveSettings({ useGroq: useGroqToggle.checked });
    });
  }
```

to:

```javascript
  if (useGroqToggle) {
    useGroqToggle.addEventListener('change', () => {
      saveSettings({ useGroq: useGroqToggle.checked });
    });
  }

  if (useHermesToggle) {
    useHermesToggle.addEventListener('change', () => {
      saveSettings({ useHermes: useHermesToggle.checked });
    });
  }
```

- [ ] **Step 3: Keep `jarvis.hermes.apiKey` in sync when the OpenRouter key is saved**

Hermes is a separate `OpenRouterClient` instance (Task 3), so it needs its own live key update alongside `jarvis.openRouter.apiKey`. In `jarvis/src/main.js`, change:

```javascript
      if (openrouterKey) {
        localStorage.setItem('jarvis_openrouter_api_key', openrouterKey);
        if (jarvis) jarvis.openRouter.apiKey = openrouterKey;
        openrouterKeyInput.value = '';
        openrouterKeyInput.placeholder = '••••••••••••••••• (saved)';
      }
```

to:

```javascript
      if (openrouterKey) {
        localStorage.setItem('jarvis_openrouter_api_key', openrouterKey);
        if (jarvis) {
          jarvis.openRouter.apiKey = openrouterKey;
          jarvis.hermes.apiKey = openrouterKey; // separate client instance, same key
        }
        openrouterKeyInput.value = '';
        openrouterKeyInput.placeholder = '••••••••••••••••• (saved)';
      }
```

- [ ] **Step 4: Run the full test suite to confirm nothing broke**

Run: `npm test`
Expected: PASS — every test file, 0 failures.

- [ ] **Step 5: Checkpoint**

Confirm every new `id` referenced in `main.js` (`useHermesToggle`) exists in the `index.html` markup added in Step 1.

- [ ] **Step 6: Commit**

```bash
git add jarvis/index.html jarvis/src/main.js
git commit -m "Add Hermes toggle to Settings UI"
```

---

## Task 5: Install MCP/Playwright dependencies

**Files:**
- Modify: `jarvis/package.json`

- [ ] **Step 1: Add the two new dependencies**

In `jarvis/package.json`, change:

```json
  "dependencies": {
    "chrono-node": "^2.10.1",
    "electron-updater": "^6.8.9",
    "leaflet": "^1.9.4",
    "lucide": "^0.344.0"
  },
```

to:

```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@playwright/mcp": "^0.0.29",
    "chrono-node": "^2.10.1",
    "electron-updater": "^6.8.9",
    "leaflet": "^1.9.4",
    "lucide": "^0.344.0"
  },
```

(These are minimum-compatible version ranges — `npm install` in Step 2 will pull whatever the current published versions actually are; the exact resolved versions in `package-lock.json` are what matters, not these floors.)

- [ ] **Step 2: Install from Windows PowerShell**

Per this repo's Windows/WSL gotcha (`AGENTS.md`), dependency installs must run from Windows PowerShell, not WSL/Git Bash — a WSL install prunes Windows-native binaries.

Run (PowerShell, from `jarvis/`):
```powershell
npm install
```
Expected: `added N packages` (`@modelcontextprotocol/sdk`, `@playwright/mcp`, and their transitive deps including `playwright-core`).

- [ ] **Step 3: Download the Chromium browser binary**

`@playwright/mcp` needs Playwright's browser binaries downloaded once — this is a new one-time setup step, separate from `npm install`.

Run (PowerShell, from `jarvis/`):
```powershell
npx playwright install chromium
```
Expected: downloads and installs the Chromium binary to the shared Playwright cache (`%USERPROFILE%\AppData\Local\ms-playwright` on Windows). Only Chromium is installed (not Firefox/WebKit) — nothing in this feature needs the other engines.

- [ ] **Step 4: Verify with a syntax/require check**

Run (from `jarvis/`):
```bash
node -e "require.resolve('@playwright/mcp/package.json'); console.log('resolved OK')"
```
Expected: `resolved OK`

- [ ] **Step 5: Commit**

```bash
git add jarvis/package.json jarvis/package-lock.json
git commit -m "Add @modelcontextprotocol/sdk and @playwright/mcp dependencies"
```

---

## Task 6: `electron/mcp-manager.cjs` — Playwright MCP client

**Files:**
- Create: `jarvis/electron/mcp-manager.cjs`

No automated test — this spawns a real child process and drives a real browser, same category as `electron/main.cjs` itself (untestable under `node --test`, verified manually in Task 11). Syntax-checked with `node --check` per this repo's convention for untested `electron/` files.

- [ ] **Step 1: Create the file**

Create `jarvis/electron/mcp-manager.cjs`:

```javascript
/**
 * Spawns and manages a single long-lived Playwright MCP server process
 * (@playwright/mcp) via the Model Context Protocol SDK, exposing two
 * narrow read-only operations: fetchWebpageText (navigate + extract) and
 * browseAndExtract (navigate, optionally locate a link's context, extract).
 * Playwright MCP's full action surface (typing, form submission, downloads,
 * arbitrary clicking) is never exposed beyond these two functions — see
 * docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md.
 *
 * The MCP SDK is ESM-only, so it's loaded via dynamic import() from this
 * CommonJS file instead of require().
 */

const path = require('path');

let clientPromise = null;

// Matches the truncation length fetchGmailFullMessage() uses for long email
// bodies elsewhere in this codebase — keeps a single huge page from blowing
// the LLM's context.
const MAX_TEXT_LENGTH = 4000;

function extractText(callToolResult) {
  if (!callToolResult || !Array.isArray(callToolResult.content)) return '';
  const text = callToolResult.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + '…' : text;
}

async function getClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    // Resolve via package.json rather than a direct subpath require, since
    // package "exports" restrictions are more reliably permissive for the
    // manifest file than for arbitrary internal paths.
    const cliPath = path.join(require.resolve('@playwright/mcp/package.json'), '..', 'cli.js');

    // --headless: no visible browser window while JARVIS "reads a page".
    // --isolated: in-memory profile, nothing persisted to disk between runs.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, '--headless', '--isolated']
    });

    const client = new Client({ name: 'jarvis-voice-ai', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    // If the spawned process dies mid-session (crash, killed, etc.), clear
    // the cached promise so the *next* call respawns instead of reusing a
    // dead connection forever.
    client.onclose = () => { clientPromise = null; };

    return client;
  })();

  // If connecting fails outright, clear the cached promise so the *next*
  // call retries spawning instead of permanently caching a rejected
  // connection.
  clientPromise.catch(() => { clientPromise = null; });

  return clientPromise;
}

/**
 * Navigates to a URL and returns the extracted readable page text.
 */
async function fetchWebpageText(url) {
  const client = await getClient();
  await client.callTool({ name: 'browser_navigate', arguments: { url } });
  const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  return extractText(snapshot);
}

/**
 * Navigates to a URL and returns the extracted readable page text. If
 * linkText is given, first searches the page for it (via browser_find) and
 * prefixes the result with that match's context — this is a search within
 * the page, not an automated click-through (Playwright MCP's click-target
 * reference format isn't stable/documented enough to parse reliably from
 * text output; an automated "follow the link" step can be a fast follow
 * once that's verified against the live tool output).
 */
async function browseAndExtract(url, linkText) {
  const client = await getClient();
  await client.callTool({ name: 'browser_navigate', arguments: { url } });

  if (linkText) {
    const found = await client.callTool({ name: 'browser_find', arguments: { text: linkText } });
    const foundText = extractText(found);
    if (foundText) {
      return `Found "${linkText}" on the page:\n${foundText}`;
    }
  }

  const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  return extractText(snapshot);
}

module.exports = { fetchWebpageText, browseAndExtract };
```

- [ ] **Step 2: Syntax-check the file**

Run (from `jarvis/`):
```bash
node --check electron/mcp-manager.cjs
```
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add jarvis/electron/mcp-manager.cjs
git commit -m "Add mcp-manager.cjs (Playwright MCP client spawn/cache)"
```

---

## Task 7: IPC wiring (`main.cjs` + `preload.cjs`)

**Files:**
- Modify: `jarvis/electron/main.cjs`
- Modify: `jarvis/electron/preload.cjs`

- [ ] **Step 1: Require `mcp-manager.cjs` and add `registerMcpIpc()`**

In `jarvis/electron/main.cjs`, add the require alongside the other top-of-file requires:

```javascript
const { classifyUpdate } = require('./update-classify.cjs');
```

becomes:

```javascript
const { classifyUpdate } = require('./update-classify.cjs');
const mcpManager = require('./mcp-manager.cjs');
```

Then, right after the closing `}` of `registerGoogleAuthIpc()` (i.e. right before the `function sendUpdateState(state) {` line), add a new function:

```javascript
function registerMcpIpc() {
  ipcMain.handle('mcp:fetch-webpage', async (event, { url }) => {
    return mcpManager.fetchWebpageText(url);
  });

  ipcMain.handle('mcp:browse-webpage', async (event, { url, linkText }) => {
    return mcpManager.browseAndExtract(url, linkText);
  });
}
```

- [ ] **Step 2: Call `registerMcpIpc()` on startup**

In `jarvis/electron/main.cjs`, change:

```javascript
  registerSpotifyAuthIpc();
  registerGoogleAuthIpc();
  registerUpdaterEvents();
```

to:

```javascript
  registerSpotifyAuthIpc();
  registerGoogleAuthIpc();
  registerMcpIpc();
  registerUpdaterEvents();
```

- [ ] **Step 3: Bridge the two new IPC calls in `preload.cjs`**

In `jarvis/electron/preload.cjs`, change:

```javascript
  calendar: {
    listEvents: (clientId, clientSecret, maxResults) => ipcRenderer.invoke('calendar:list-events', { clientId, clientSecret, maxResults }),
    search: (clientId, clientSecret, query, maxResults) => ipcRenderer.invoke('calendar:search-events', { clientId, clientSecret, query, maxResults }),
    createEvent: (clientId, clientSecret, title, description, startISO, endISO) => ipcRenderer.invoke('calendar:create-event', { clientId, clientSecret, title, description, startISO, endISO })
  },
```

to:

```javascript
  calendar: {
    listEvents: (clientId, clientSecret, maxResults) => ipcRenderer.invoke('calendar:list-events', { clientId, clientSecret, maxResults }),
    search: (clientId, clientSecret, query, maxResults) => ipcRenderer.invoke('calendar:search-events', { clientId, clientSecret, query, maxResults }),
    createEvent: (clientId, clientSecret, title, description, startISO, endISO) => ipcRenderer.invoke('calendar:create-event', { clientId, clientSecret, title, description, startISO, endISO })
  },
  mcp: {
    fetchWebpage: (url) => ipcRenderer.invoke('mcp:fetch-webpage', { url }),
    browseWebpage: (url, linkText) => ipcRenderer.invoke('mcp:browse-webpage', { url, linkText })
  },
```

- [ ] **Step 4: Syntax-check both files**

Run (from `jarvis/`):
```bash
node --check electron/main.cjs
node --check electron/preload.cjs
```
Expected: no output from either (syntax OK).

- [ ] **Step 5: Commit**

```bash
git add jarvis/electron/main.cjs jarvis/electron/preload.cjs
git commit -m "Wire mcp:fetch-webpage/mcp:browse-webpage IPC handlers"
```

---

## Task 8: `McpWebHarness`

**Files:**
- Create: `jarvis/src/mcp-web-harness.js`
- Test: `jarvis/test/mcp-web-harness.test.js`

- [ ] **Step 1: Write the failing tests**

Create `jarvis/test/mcp-web-harness.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { McpWebHarness } = await import('../src/mcp-web-harness.js');

function resetWindow() {
  global.window = {};
}

test('fetchWebpage returns a not-available message outside Electron', async () => {
  resetWindow();
  const harness = new McpWebHarness();
  const result = await harness.fetchWebpage('https://example.com');
  assert.equal(result.success, false);
  assert.match(result.message, /not available/i);
});

test('fetchWebpage delegates to window.jarvisElectron.mcp.fetchWebpage and returns the extracted text', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    mcp: { fetchWebpage: async (url) => `Page content for ${url}` }
  };
  const harness = new McpWebHarness();
  const result = await harness.fetchWebpage('https://example.com');
  assert.equal(result.success, true);
  assert.equal(result.text, 'Page content for https://example.com');
});

test('fetchWebpage returns a graceful failure message when the IPC call throws', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    mcp: { fetchWebpage: async () => { throw new Error('MCP server crashed'); } }
  };
  const harness = new McpWebHarness();
  const result = await harness.fetchWebpage('https://example.com');
  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to read/i);
});

test('fetchWebpage returns a graceful message when the page has no extractable text', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    mcp: { fetchWebpage: async () => '' }
  };
  const harness = new McpWebHarness();
  const result = await harness.fetchWebpage('https://example.com');
  assert.equal(result.success, false);
  assert.match(result.message, /no readable content/i);
});

test('browseWebpage returns a not-available message outside Electron', async () => {
  resetWindow();
  const harness = new McpWebHarness();
  const result = await harness.browseWebpage('https://example.com', 'pricing');
  assert.equal(result.success, false);
  assert.match(result.message, /not available/i);
});

test('browseWebpage delegates to window.jarvisElectron.mcp.browseWebpage with the url and linkText', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    mcp: {
      browseWebpage: async (url, linkText) => {
        calls.push({ url, linkText });
        return 'Found "pricing" on the page: $10/month';
      }
    }
  };
  const harness = new McpWebHarness();
  const result = await harness.browseWebpage('https://example.com', 'pricing');
  assert.equal(result.success, true);
  assert.equal(result.text, 'Found "pricing" on the page: $10/month');
  assert.deepEqual(calls, [{ url: 'https://example.com', linkText: 'pricing' }]);
});

test('browseWebpage returns a graceful failure message when the IPC call throws', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    mcp: { browseWebpage: async () => { throw new Error('navigation timeout'); } }
  };
  const harness = new McpWebHarness();
  const result = await harness.browseWebpage('https://example.com');
  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to read/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/mcp-web-harness.test.js`
Expected: FAIL — `Cannot find module '../src/mcp-web-harness.js'`.

- [ ] **Step 3: Write the implementation**

Create `jarvis/src/mcp-web-harness.js`:

```javascript
/**
 * JARVIS MCP Web Harness — real webpage reading via the Playwright MCP
 * server, spawned and driven entirely in the Electron main process (see
 * electron/mcp-manager.cjs). Unlike GmailHarness/GoogleCalendarHarness this
 * needs no credentials and no account connection — just the Electron IPC
 * bridge, which only exists in the packaged/dev-Electron app, not in plain
 * dev-browser mode (localhost:3000 without Electron). See
 * docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md.
 */

export class McpWebHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.mcp;
  }

  _notAvailable() {
    return { success: false, message: 'Web browsing is not available outside the JARVIS desktop app, Sir.' };
  }

  /**
   * Navigates to a URL and returns the extracted readable page text.
   */
  async fetchWebpage(url) {
    if (!this._isElectron()) return this._notAvailable();
    try {
      const text = await window.jarvisElectron.mcp.fetchWebpage(url);
      if (!text) return { success: false, message: `I found no readable content at ${url}, Sir.` };
      this.onLog({ type: 'SUCCESS', message: `[MCP WEB] Fetched ${url} (${text.length} chars).` });
      return { success: true, text };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[MCP WEB] fetchWebpage failed: ${err.message}` });
      return { success: false, message: `I wasn't able to read ${url}, Sir.` };
    }
  }

  /**
   * Navigates to a URL, optionally searches the page for linkText, and
   * returns the extracted readable text (see browseAndExtract in
   * mcp-manager.cjs for exactly what "optionally" means here).
   */
  async browseWebpage(url, linkText) {
    if (!this._isElectron()) return this._notAvailable();
    try {
      const text = await window.jarvisElectron.mcp.browseWebpage(url, linkText);
      if (!text) return { success: false, message: `I found no readable content at ${url}, Sir.` };
      this.onLog({ type: 'SUCCESS', message: `[MCP WEB] Browsed ${url} (${text.length} chars).` });
      return { success: true, text };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[MCP WEB] browseWebpage failed: ${err.message}` });
      return { success: false, message: `I wasn't able to read ${url}, Sir.` };
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/mcp-web-harness.test.js`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: PASS — every test file, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add jarvis/src/mcp-web-harness.js jarvis/test/mcp-web-harness.test.js
git commit -m "Add McpWebHarness"
```

---

## Task 9: `web_search` replacement + `browse_webpage` tool

**Files:**
- Modify: `jarvis/src/jarvis-tools.js`
- Modify: `jarvis/test/jarvis-tools.test.js`

- [ ] **Step 1: Write the failing tests**

In `jarvis/test/jarvis-tools.test.js`, replace the tool-name-list test:

```javascript
test('GROUNDING_TOOLS only lists read-only tools, no action tools', () => {
  const names = GROUNDING_TOOLS.map(t => t.function.name);
  assert.deepEqual(names, ['solve_math', 'web_search', 'list_recent_emails', 'search_emails', 'list_upcoming_events', 'search_calendar_events', 'get_location']);
});
```

with:

```javascript
test('GROUNDING_TOOLS only lists read-only tools, no action tools', () => {
  const names = GROUNDING_TOOLS.map(t => t.function.name);
  assert.deepEqual(names, ['solve_math', 'web_search', 'list_recent_emails', 'search_emails', 'list_upcoming_events', 'search_calendar_events', 'get_location', 'browse_webpage']);
});
```

Replace the three existing `web_search` tests (lines 39-66: `'web_search delegates to harness.fetchLiveSearchAnswer...'`, `'web_search replaces the tab-opening fallback sentinel...'`, `'web_search returns a graceful fallback string when the harness throws'`) — they test the old DuckDuckGo-via-harness implementation, which no longer exists — with:

```javascript
test('web_search builds a Google search URL and delegates to mcpWeb.fetchWebpage', async () => {
  const calls = [];
  const mcpWeb = { fetchWebpage: async (url) => { calls.push(url); return { success: true, text: 'Paris is the capital of France.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('web_search', '{"query":"capital of France"}');

  assert.equal(result, 'Paris is the capital of France.');
  assert.deepEqual(calls, ['https://www.google.com/search?q=capital%20of%20France']);
});

test('web_search returns a graceful fallback string when mcpWeb reports failure', async () => {
  const mcpWeb = { fetchWebpage: async () => ({ success: false, message: 'not available' }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('web_search', '{"query":"xyz"}');

  assert.equal(result, 'No web search result found for this query.');
});

test('web_search returns a graceful fallback string when mcpWeb.fetchWebpage throws', async () => {
  const mcpWeb = { fetchWebpage: async () => { throw new Error('network error'); } };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('web_search', '{"query":"xyz"}');

  assert.equal(result, 'No web search result found for this query.');
});

test('web_search returns a graceful fallback string when mcpWeb is not wired up', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  const result = await executor('web_search', '{"query":"xyz"}');

  assert.equal(result, 'No web search result found for this query.');
});
```

Then append these new tests at the end of the file:

```javascript
test('browse_webpage delegates to mcpWeb.browseWebpage with the parsed url and linkText', async () => {
  const calls = [];
  const mcpWeb = { browseWebpage: async (url, linkText) => { calls.push({ url, linkText }); return { success: true, text: 'Pricing: $10/month.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('browse_webpage', '{"url":"https://example.com","linkText":"pricing"}');

  assert.equal(result, 'Pricing: $10/month.');
  assert.deepEqual(calls, [{ url: 'https://example.com', linkText: 'pricing' }]);
});

test('browse_webpage works without linkText (url only)', async () => {
  const calls = [];
  const mcpWeb = { browseWebpage: async (url, linkText) => { calls.push({ url, linkText }); return { success: true, text: 'Homepage content.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('browse_webpage', '{"url":"https://example.com"}');

  assert.equal(result, 'Homepage content.');
  assert.deepEqual(calls, [{ url: 'https://example.com', linkText: undefined }]);
});

test('browse_webpage returns a graceful fallback string when mcpWeb reports failure', async () => {
  const mcpWeb = { browseWebpage: async () => ({ success: false, message: 'not available' }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('browse_webpage', '{"url":"https://example.com"}');

  assert.equal(result, 'Unable to read that webpage.');
});

test('browse_webpage returns a graceful fallback string when mcpWeb.browseWebpage throws', async () => {
  const mcpWeb = { browseWebpage: async () => { throw new Error('navigation timeout'); } };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('browse_webpage', '{"url":"https://example.com"}');

  assert.equal(result, 'Unable to read that webpage.');
});

test('browse_webpage returns a graceful fallback string when mcpWeb is not wired up', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  const result = await executor('browse_webpage', '{"url":"https://example.com"}');

  assert.equal(result, 'Unable to read that webpage.');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/jarvis-tools.test.js`
Expected: FAIL — the tool-name-list assertion fails (`browse_webpage` missing), the new `web_search` tests fail (still calling `harness.fetchLiveSearchAnswer`, not `mcpWeb.fetchWebpage`), and the `browse_webpage` tests fail (`Unknown tool: browse_webpage`).

- [ ] **Step 3: Implement in `jarvis-tools.js`**

Add a new fallback constant near the top, right after `NO_CALENDAR_RESULT`:

```javascript
const NO_WEBPAGE_RESULT = 'Unable to read that webpage.';
```

Append a new entry to the `GROUNDING_TOOLS` array, right after the `get_location` entry (inside the closing `];`):

```javascript
  {
    type: 'function',
    function: {
      name: 'browse_webpage',
      description: "Reads the actual content of a specific webpage by URL. Use this when you already have a URL — e.g. from a prior web_search result or one the user mentioned — and want its real content, not just a search snippet.",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to read, including https://.' },
          linkText: { type: 'string', description: 'Optional — text to search for within the page (e.g. a link or heading), to focus the result on that section.' }
        },
        required: ['url']
      }
    }
  }
```

Change the `createToolExecutor` signature to accept `mcpWeb`:

```javascript
export function createToolExecutor({ wolfram, harness, gmail, calendar, location, getGoogleCredentials, onLog = () => {} }) {
```

becomes:

```javascript
export function createToolExecutor({ wolfram, harness, gmail, calendar, location, mcpWeb, getGoogleCredentials, onLog = () => {} }) {
```

Replace the entire `web_search` block:

```javascript
    if (name === 'web_search') {
      const query = args.query || '';
      try {
        const answer = harness ? await harness.fetchLiveSearchAnswer(query) : null;
        const usable = answer && !answer.startsWith(HARNESS_NO_RESULT_PREFIX) ? answer : NO_SEARCH_RESULT;
        onLog({ type: 'TOOL', message: `[TOOL CALL] web_search("${query}") -> ${usable === NO_SEARCH_RESULT ? 'no result' : `"${usable}"`}` });
        return usable;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] web_search failed: ${e.message}` });
        return NO_SEARCH_RESULT;
      }
    }
```

with:

```javascript
    if (name === 'web_search') {
      const query = args.query || '';
      try {
        if (!mcpWeb) return NO_SEARCH_RESULT;
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const result = await mcpWeb.fetchWebpage(searchUrl);
        onLog({ type: 'TOOL', message: `[TOOL CALL] web_search("${query}") -> ${result.success ? 'result found' : 'no result'}` });
        return result.success ? result.text : NO_SEARCH_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] web_search failed: ${e.message}` });
        return NO_SEARCH_RESULT;
      }
    }
```

Add a new branch right after the `get_location` block and before the final `onLog({ type: 'WARNING', message: ... Unknown tool ... });` fallback:

```javascript
    if (name === 'browse_webpage') {
      const url = args.url || '';
      const linkText = args.linkText;
      try {
        if (!mcpWeb) return NO_WEBPAGE_RESULT;
        const result = await mcpWeb.browseWebpage(url, linkText);
        onLog({ type: 'TOOL', message: `[TOOL CALL] browse_webpage("${url}") -> ${result.success ? 'result found' : 'no result'}` });
        return result.success ? result.text : NO_WEBPAGE_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] browse_webpage failed: ${e.message}` });
        return NO_WEBPAGE_RESULT;
      }
    }
```

`HARNESS_NO_RESULT_PREFIX` is now unused (only `web_search`'s old implementation referenced it) — remove its declaration:

```javascript
const NO_SEARCH_RESULT = 'No web search result found for this query.';
// The exact sentinel BrowserHarness.fetchLiveSearchAnswer() falls back to —
// written for its tab-opening caller (executeGoogleSearch). This tool never
// opens a tab, so that sentinel would be misleading if handed to the model.
const HARNESS_NO_RESULT_PREFIX = 'I have launched a Google search for';
const NO_EMAIL_RESULT = 'Gmail is not connected or no matching emails were found.';
```

becomes:

```javascript
const NO_SEARCH_RESULT = 'No web search result found for this query.';
const NO_EMAIL_RESULT = 'Gmail is not connected or no matching emails were found.';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/jarvis-tools.test.js`
Expected: PASS — all tests, including the 4 rewritten `web_search` tests and 5 new `browse_webpage` tests.

- [ ] **Step 5: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: PASS — every test file, 0 failures. `harness` is still a `createToolExecutor` parameter (used by nothing now, but removing it isn't required — leaving it is harmless and avoids touching call sites that still pass it) — confirm no test asserts on its absence.

- [ ] **Step 6: Commit**

```bash
git add jarvis/src/jarvis-tools.js jarvis/test/jarvis-tools.test.js
git commit -m "Replace web_search's DuckDuckGo lookup with real MCP page fetch, add browse_webpage tool"
```

---

## Task 10: Wire `McpWebHarness` into `JarvisCore`

**Files:**
- Modify: `jarvis/src/jarvis-core.js`
- Test: `jarvis/test/jarvis-tools.test.js` is already covered by Task 9; this task wires the real harness into the constructor, verified by a `jarvis-core`-level test.

- [ ] **Step 1: Write the failing test**

Create `jarvis/test/jarvis-core.mcp-web.test.js`:

```javascript
/**
 * Confirms McpWebHarness is actually wired into JarvisCore's toolExecutor,
 * not just imported — mirrors the shape of the Gmail/Calendar/Location
 * grounding-tool wiring tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('web_search grounding tool reaches the real McpWebHarness instance on JarvisCore', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.mcpWebHarness.fetchWebpage = async (url) => {
    calls.push(url);
    return { success: true, text: 'Search result text.' };
  };

  const result = await jarvis.toolExecutor('web_search', '{"query":"weather today"}');

  assert.equal(result, 'Search result text.');
  assert.deepEqual(calls, ['https://www.google.com/search?q=weather%20today']);
});

test('browse_webpage grounding tool reaches the real McpWebHarness instance on JarvisCore', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.mcpWebHarness.browseWebpage = async (url, linkText) => {
    calls.push({ url, linkText });
    return { success: true, text: 'Page content.' };
  };

  const result = await jarvis.toolExecutor('browse_webpage', '{"url":"https://example.com","linkText":"about"}');

  assert.equal(result, 'Page content.');
  assert.deepEqual(calls, [{ url: 'https://example.com', linkText: 'about' }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/jarvis-core.mcp-web.test.js`
Expected: FAIL — `jarvis.mcpWebHarness` is `undefined` (`Cannot set properties of undefined`), since `JarvisCore` doesn't instantiate `McpWebHarness` yet and `createToolExecutor` isn't passed `mcpWeb`.

- [ ] **Step 3: Import, instantiate, and wire `McpWebHarness`**

In `jarvis/src/jarvis-core.js`, add the import alongside the other harness imports:

```javascript
import { LocationHarness } from './location-harness.js';
```

becomes:

```javascript
import { LocationHarness } from './location-harness.js';
import { McpWebHarness } from './mcp-web-harness.js';
```

Right after the existing `this.locationHarness = new LocationHarness({...});` block, add:

```javascript

    // MCP Web Harness — real webpage reading via the Playwright MCP server
    // spawned in the Electron main process (electron/mcp-manager.cjs). No
    // credentials, no account connection. Exposed as the web_search
    // (upgraded from the old DuckDuckGo-only lookup) and browse_webpage
    // grounding tools below. See
    // docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md.
    this.mcpWebHarness = new McpWebHarness({
      onLog: (logData) => this.onLog(logData)
    });
```

Update the `this.toolExecutor = createToolExecutor({...})` call to pass it through:

```javascript
    this.toolExecutor = createToolExecutor({
      wolfram: this.wolfram,
      harness: this.harness,
      gmail: this.gmailHarness,
      calendar: this.calendarHarness,
      location: this.locationHarness,
      getGoogleCredentials: () => ({ clientId: this.googleClientId, clientSecret: this.googleClientSecret }),
      onLog: (logData) => this.onLog(logData)
    });
```

becomes:

```javascript
    this.toolExecutor = createToolExecutor({
      wolfram: this.wolfram,
      harness: this.harness,
      gmail: this.gmailHarness,
      calendar: this.calendarHarness,
      location: this.locationHarness,
      mcpWeb: this.mcpWebHarness,
      getGoogleCredentials: () => ({ clientId: this.googleClientId, clientSecret: this.googleClientSecret }),
      onLog: (logData) => this.onLog(logData)
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/jarvis-core.mcp-web.test.js`
Expected: PASS — 2 tests, 0 failures.

- [ ] **Step 5: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: PASS — every test file, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add jarvis/src/jarvis-core.js jarvis/test/jarvis-core.mcp-web.test.js
git commit -m "Wire McpWebHarness into JarvisCore's grounding-tool executor"
```

---

## Task 11: Docs + final verification

**Files:**
- Modify: `AGENTS.md`
- No code files — verification only.

- [ ] **Step 1: Document the two new gotchas**

In `AGENTS.md`, find the `## Gotchas` section and its last bullet:

```markdown
- The Location panel needs `navigator.geolocation`, which Electron **silently denies** by default when no `setPermissionRequestHandler` is registered (no native OS prompt appears — `getCurrentPosition` just errors). `main.cjs` auto-approves `'geolocation'` (alongside `'media'`); if you remove or replace that handler, the Location map will break without any visible error.
```

Change to:

```markdown
- The Location panel needs `navigator.geolocation`, which Electron **silently denies** by default when no `setPermissionRequestHandler` is registered (no native OS prompt appears — `getCurrentPosition` just errors). `main.cjs` auto-approves `'geolocation'` (alongside `'media'`); if you remove or replace that handler, the Location map will break without any visible error.
- The `web_search`/`browse_webpage` grounding tools need Playwright's browser binary downloaded once: `npx playwright install chromium` (from `jarvis/`, after `npm install`). Without it, `electron/mcp-manager.cjs`'s spawned `@playwright/mcp` process fails on first navigation and both tools degrade to their "unable to read" fallback message — no crash, but silently useless until the binary is installed.
- Hermes (`useHermes` setting) is **not** part of the free-model pool like everything else in this app — it's a real paid OpenRouter model (`nousresearch/hermes-4-405b`). It reuses the existing OpenRouter API key (no new key to configure), but toggling it on spends OpenRouter credits on every request.
```

- [ ] **Step 2: Run the full automated test suite**

Run (PowerShell or Bash, from `jarvis/`): `npm test`
Expected: PASS — every test file, 0 failures, including all tests added across Tasks 1–10.

- [ ] **Step 3: Syntax-check every modified `electron/` file**

Run (from `jarvis/`):
```bash
node --check electron/main.cjs
node --check electron/preload.cjs
node --check electron/mcp-manager.cjs
```
Expected: no output from any (syntax OK).

- [ ] **Step 4: Manual verification in the running app**

With `npm run dev` and `npm run electron` running (kill and restart both if they were already running from a prior session, per this repo's existing workflow):

1. Open Settings — confirm the new "Use Hermes" switch appears next to "Use Groq", off by default.
2. Ask JARVIS a question that needs a live fact (e.g. "search the web for today's date") with `useHermes` off — confirm the answer arrives and the terminal console shows `[MCP WEB]` log lines instead of the old DuckDuckGo-only behavior. First run will be slower than usual (Playwright MCP's process spawns and a headless Chromium instance launches on the first call); subsequent calls in the same session reuse the cached client and are faster.
3. Flip "Use Hermes" on, ask another question — console should show `[HARNESS]`/`[SUCCESS]` logs mentioning a `nousresearch/hermes-4-405b` model try, confirming the switch changes which model answers, with no reload needed.
4. If Chromium's browser binary was never installed (Task 5, Step 3 skipped), confirm the failure is graceful: JARVIS should say it wasn't able to read the page/find a result, not crash or hang.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "Document Playwright setup and Hermes cost gotchas"
```

- [ ] **Step 6: Final checkpoint**

Confirm Step 2's automated `PASS` output and Step 4's manual checklist both succeeded before considering this plan done.
