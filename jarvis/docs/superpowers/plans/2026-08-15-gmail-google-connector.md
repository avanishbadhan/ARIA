# Gmail Integration & Google Account Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JARVIS can check, search, and read the user's Gmail on voice/text command, and reach for the same data autonomously mid-conversation, gated behind a read-only Google OAuth connection.

**Architecture:** A generic `GoogleAccountConnector` (renderer) wraps OAuth status/login/logout over an Electron IPC bridge; `GmailHarness` (renderer) does the actual read operations over that same bridge. The Electron main process owns the real OAuth flow (loopback redirect + PKCE, `safeStorage`-encrypted tokens, token refresh) and the Gmail API calls, mirroring the existing Spotify account-connection code almost exactly. Two dispatch paths expose it to the LLM: explicit intents (`GMAIL_CHECK_INBOX`/`GMAIL_SEARCH`/`GMAIL_READ_MESSAGE`) and autonomous grounding tools (`list_recent_emails`/`search_emails`).

**Tech Stack:** Vanilla JS (ES modules), Electron (`ipcMain`/`ipcRenderer`/`contextBridge`/`safeStorage`), Node's built-in `https`/`http`/`crypto` (no new npm dependencies), `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-15-gmail-google-connector-design.md`

---

## Task 1: `GoogleAccountConnector` (generic OAuth wrapper)

**Files:**
- Create: `src/google-account-connector.js`
- Test: `test/google-account-connector.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/google-account-connector.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { GoogleAccountConnector } = await import('../src/google-account-connector.js');

function resetWindow() {
  global.window = {};
}

test('authStatus returns not-authenticated when not running inside Electron', async () => {
  resetWindow();
  const connector = new GoogleAccountConnector();
  const result = await connector.authStatus();
  assert.equal(result.authenticated, false);
});

test('authStatus delegates to window.jarvisElectron.googleAuth.status()', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, googleAuth: { status: async () => ({ authenticated: true }) } };
  const connector = new GoogleAccountConnector();
  const result = await connector.authStatus();
  assert.equal(result.authenticated, true);
});

test('authStatus returns not-authenticated when the bridge call throws', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, googleAuth: { status: async () => { throw new Error('IPC error'); } } };
  const connector = new GoogleAccountConnector();
  const result = await connector.authStatus();
  assert.equal(result.authenticated, false);
});

test('login throws outside Electron instead of silently doing nothing', async () => {
  resetWindow();
  const connector = new GoogleAccountConnector();
  await assert.rejects(() => connector.login('id', 'secret'), /desktop app/i);
});

test('login delegates to window.jarvisElectron.googleAuth.login() with the credentials', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = { isElectron: true, googleAuth: { login: async (id, secret) => { calls.push({ id, secret }); return { success: true }; } } };
  const connector = new GoogleAccountConnector();
  const result = await connector.login('client-id', 'client-secret');
  assert.equal(result.success, true);
  assert.deepEqual(calls, [{ id: 'client-id', secret: 'client-secret' }]);
});

test('logout resolves to success outside Electron without calling anything', async () => {
  resetWindow();
  const connector = new GoogleAccountConnector();
  const result = await connector.logout();
  assert.equal(result.success, true);
});

test('logout delegates to window.jarvisElectron.googleAuth.logout()', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = { isElectron: true, googleAuth: { logout: async () => { calls.push(1); return { success: true }; } } };
  const connector = new GoogleAccountConnector();
  await connector.logout();
  assert.equal(calls.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern=".*" test/google-account-connector.test.js` (or simply `node --test test/google-account-connector.test.js`)
Expected: FAIL — `Cannot find module '../src/google-account-connector.js'`

- [ ] **Step 3: Write the implementation**

Create `src/google-account-connector.js`:

```js
/**
 * Generic Google OAuth account connector for JARVIS. Gmail-agnostic on
 * purpose — GmailHarness is its first consumer, but a future Calendar/Drive
 * harness reuses this same connector without touching this file. Mirrors
 * SpotifyHarness's auth-only surface (authStatus/login/logout); the actual
 * OAuth loopback flow lives in electron/main.cjs, this is just the bridge.
 */

export class GoogleAccountConnector {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.googleAuth;
  }

  /**
   * Whether the user has connected their own Google account (OAuth) — read
   * operations against Gmail require this; there is no anonymous fallback
   * the way Spotify's Client Credentials flow provides one.
   */
  async authStatus() {
    if (!this._isElectron()) return { authenticated: false };
    try {
      return await window.jarvisElectron.googleAuth.status();
    } catch (e) {
      return { authenticated: false };
    }
  }

  /**
   * Opens the system browser for the user to approve access, via a local
   * loopback OAuth redirect handled in the Electron main process. Only ever
   * called from an explicit Settings button click — never voice, never
   * model-initiated.
   */
  async login(clientId, clientSecret) {
    if (!this._isElectron()) {
      throw new Error('Connecting your Google account requires the JARVIS desktop app.');
    }
    return window.jarvisElectron.googleAuth.login(clientId, clientSecret);
  }

  async logout() {
    if (!this._isElectron()) return { success: true };
    return window.jarvisElectron.googleAuth.logout();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/google-account-connector.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/google-account-connector.js test/google-account-connector.test.js
git commit -m "Add GoogleAccountConnector (generic OAuth wrapper for Google account connection)"
```

---

## Task 2: `GmailHarness` (read-only Gmail operations)

**Files:**
- Create: `src/gmail-harness.js`
- Test: `test/gmail-harness.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/gmail-harness.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { GmailHarness } = await import('../src/gmail-harness.js');

function resetWindow() {
  global.window = {};
}

test('listRecent returns a not-connected message outside Electron', async () => {
  resetWindow();
  const harness = new GmailHarness();
  const result = await harness.listRecent('id', 'secret');
  assert.equal(result.success, false);
  assert.match(result.message, /connect/i);
});

test('listRecent returns a spoken summary naming the most recent message', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    gmail: {
      listMessages: async () => ([
        { id: '1', from: 'Alex Chen <alex@example.com>', subject: 'Q3 budget review', snippet: 'Here is the summary...', date: 'Mon, 1 Jan 2026' },
        { id: '2', from: 'Github <noreply@github.com>', subject: 'New PR', snippet: 'Someone opened a PR', date: 'Sun, 31 Dec 2025' }
      ])
    }
  };
  const harness = new GmailHarness();
  const result = await harness.listRecent('id', 'secret');
  assert.equal(result.success, true);
  assert.equal(result.messages.length, 2);
  assert.match(result.message, /Alex Chen/);
  assert.match(result.message, /Q3 budget review/);
});

test('listRecent reports an empty inbox without erroring', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, gmail: { listMessages: async () => [] } };
  const harness = new GmailHarness();
  const result = await harness.listRecent('id', 'secret');
  assert.equal(result.success, true);
  assert.match(result.message, /no recent messages/i);
});

test('listRecent returns a graceful failure message when the IPC call throws', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, gmail: { listMessages: async () => { throw new Error('Not connected to Google.'); } } };
  const harness = new GmailHarness();
  const result = await harness.listRecent('id', 'secret');
  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to check/i);
});

test('search returns a spoken summary of the top match and forwards maxResults', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    gmail: {
      search: async (clientId, clientSecret, query, maxResults) => {
        calls.push({ clientId, clientSecret, query, maxResults });
        return [{ id: '1', from: 'Recruiter <r@example.com>', subject: 'Following up', snippet: 'Just checking in...', date: 'Mon, 1 Jan 2026' }];
      }
    }
  };
  const harness = new GmailHarness();
  const result = await harness.search('id', 'secret', 'recruiter');

  assert.equal(result.success, true);
  assert.match(result.message, /Recruiter/);
  assert.deepEqual(calls, [{ clientId: 'id', clientSecret: 'secret', query: 'recruiter', maxResults: 10 }]);
});

test('search reports no matches without erroring', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, gmail: { search: async () => [] } };
  const harness = new GmailHarness();
  const result = await harness.search('id', 'secret', 'nonexistent');
  assert.equal(result.success, true);
  assert.match(result.message, /didn't find/i);
});

test('getMessage returns the formatted message body', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    gmail: { getMessage: async () => ({ id: '1', from: 'Alex Chen <alex@example.com>', subject: 'Q3 budget review', date: 'Mon, 1 Jan 2026', body: 'Here is the full budget breakdown.' }) }
  };
  const harness = new GmailHarness();
  const result = await harness.getMessage('id', 'secret', '1');
  assert.equal(result.success, true);
  assert.match(result.message, /Alex Chen/);
  assert.match(result.message, /budget breakdown/);
});

test('readMessage searches first, then reads the top match', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    gmail: {
      search: async (clientId, clientSecret, query, maxResults) => { calls.push(['search', query, maxResults]); return [{ id: 'abc', from: 'Sarah <sarah@example.com>', subject: 'Trip plans', snippet: '...', date: 'x' }]; },
      getMessage: async (clientId, clientSecret, id) => { calls.push(['get', id]); return { id, from: 'Sarah <sarah@example.com>', subject: 'Trip plans', date: 'x', body: "Let's go next week." }; }
    }
  };
  const harness = new GmailHarness();
  const result = await harness.readMessage('id', 'secret', 'sarah');

  assert.equal(result.success, true);
  assert.match(result.message, /Trip plans/);
  assert.deepEqual(calls, [['search', 'sarah', 1], ['get', 'abc']]);
});

test('readMessage reports no match without calling getMessage', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    gmail: {
      search: async () => { calls.push('search'); return []; },
      getMessage: async () => { calls.push('get'); return {}; }
    }
  };
  const harness = new GmailHarness();
  const result = await harness.readMessage('id', 'secret', 'nobody');

  assert.equal(result.success, false);
  assert.match(result.message, /couldn't find/i);
  assert.deepEqual(calls, ['search']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/gmail-harness.test.js`
Expected: FAIL — `Cannot find module '../src/gmail-harness.js'`

- [ ] **Step 3: Write the implementation**

Create `src/gmail-harness.js`:

```js
/**
 * JARVIS Gmail Harness — read-only operations (list recent, search, read a
 * message) against the user's own connected Gmail account. Requires a
 * GoogleAccountConnector login first (see google-account-connector.js); a
 * not-connected account is never a dead end, it returns a spoken prompt to
 * connect in Settings, same as SpotifyHarness's not-connected fallback.
 * Client ID/Secret are passed into every call rather than stored here,
 * mirroring SpotifyHarness — this harness holds no credentials itself.
 */

export class GmailHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.gmail;
  }

  _notConnected() {
    return { success: false, message: "Your Google account isn't connected yet. Connect it in Settings, Sir." };
  }

  _summarizeList(messages) {
    if (!messages.length) return 'Your inbox has no recent messages, Sir.';
    const top = messages[0];
    return `You have ${messages.length} recent email${messages.length === 1 ? '' : 's'}. The most recent is from ${top.from}: "${top.subject}".`;
  }

  _summarizeSearch(messages, query) {
    if (!messages.length) return `I didn't find any emails matching "${query}", Sir.`;
    const top = messages[0];
    return `I found ${messages.length} email${messages.length === 1 ? '' : 's'} matching "${query}". The top result is from ${top.from}: "${top.subject}".`;
  }

  /**
   * Lists the most recent messages in the inbox.
   */
  async listRecent(clientId, clientSecret, maxResults = 10) {
    if (!this._isElectron()) return this._notConnected();
    try {
      const messages = await window.jarvisElectron.gmail.listMessages(clientId, clientSecret, maxResults);
      this.onLog({ type: 'SUCCESS', message: `[GMAIL] Listed ${messages.length} recent message(s).` });
      return { success: true, messages, message: this._summarizeList(messages) };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[GMAIL] listRecent failed: ${err.message}` });
      return { success: false, message: "I wasn't able to check your email, Sir." };
    }
  }

  /**
   * Full-text searches the mailbox (Gmail's own server-side search, same
   * syntax as the Gmail search bar).
   */
  async search(clientId, clientSecret, query, maxResults = 10) {
    if (!this._isElectron()) return this._notConnected();
    try {
      const messages = await window.jarvisElectron.gmail.search(clientId, clientSecret, query, maxResults);
      this.onLog({ type: 'SUCCESS', message: `[GMAIL] Search "${query}" -> ${messages.length} result(s).` });
      return { success: true, messages, message: this._summarizeSearch(messages, query) };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[GMAIL] search failed: ${err.message}` });
      return { success: false, message: "I wasn't able to search your email, Sir." };
    }
  }

  /**
   * Fetches one full message (headers + decoded plain-text body) by ID.
   */
  async getMessage(clientId, clientSecret, id) {
    if (!this._isElectron()) return this._notConnected();
    try {
      const msg = await window.jarvisElectron.gmail.getMessage(clientId, clientSecret, id);
      if (!msg) return { success: false, message: "I couldn't open that email, Sir." };
      return { success: true, ...msg, message: `From ${msg.from}, subject "${msg.subject}": ${msg.body}` };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[GMAIL] getMessage failed: ${err.message}` });
      return { success: false, message: "I wasn't able to open that email, Sir." };
    }
  }

  /**
   * Resolves a natural-language query ("the email from Sarah", "the invoice
   * from accounting") to a specific message and reads it. Gmail's search API
   * is already a real full-text/sender search, so — unlike SpotifyHarness's
   * local list + fuzzy-match — the top search hit is the resolution; no
   * separate matching step is needed.
   */
  async readMessage(clientId, clientSecret, query) {
    const searchResult = await this.search(clientId, clientSecret, query, 1);
    if (!searchResult.success || !searchResult.messages.length) {
      return { success: false, message: `I couldn't find an email matching "${query}", Sir.` };
    }
    return this.getMessage(clientId, clientSecret, searchResult.messages[0].id);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/gmail-harness.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gmail-harness.js test/gmail-harness.test.js
git commit -m "Add GmailHarness (read-only list/search/read against connected Gmail account)"
```

---

## Task 3: Gmail grounding tools (autonomous LLM function-calling)

**Files:**
- Modify: `src/jarvis-tools.js`
- Modify: `test/jarvis-tools.test.js`

- [ ] **Step 1: Write the failing tests**

In `test/jarvis-tools.test.js`, replace the first test (the exact tool-name list assertion):

```js
test('GROUNDING_TOOLS only lists read-only tools, no action tools', () => {
  const names = GROUNDING_TOOLS.map(t => t.function.name);
  assert.deepEqual(names, ['solve_math', 'web_search', 'list_recent_emails', 'search_emails']);
});
```

Then append these tests at the end of the file:

```js
test('list_recent_emails delegates to gmail.listRecent using the stored Google credentials', async () => {
  const calls = [];
  const gmail = { listRecent: async (clientId, clientSecret) => { calls.push({ clientId, clientSecret }); return { success: true, messages: [{}], message: 'You have 1 recent email.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, gmail, getGoogleCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }) });

  const result = await executor('list_recent_emails', '{}');

  assert.equal(result, 'You have 1 recent email.');
  assert.deepEqual(calls, [{ clientId: 'id', clientSecret: 'secret' }]);
});

test('list_recent_emails returns a graceful fallback string when Gmail reports failure', async () => {
  const gmail = { listRecent: async () => ({ success: false, message: 'not connected' }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, gmail, getGoogleCredentials: () => ({ clientId: '', clientSecret: '' }) });

  const result = await executor('list_recent_emails', '{}');

  assert.match(result, /not connected|no matching/i);
});

test('search_emails delegates to gmail.search with the parsed query', async () => {
  const calls = [];
  const gmail = { search: async (clientId, clientSecret, query) => { calls.push(query); return { success: true, messages: [{}], message: 'Found it.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, gmail, getGoogleCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }) });

  const result = await executor('search_emails', '{"query":"recruiter"}');

  assert.equal(result, 'Found it.');
  assert.deepEqual(calls, ['recruiter']);
});

test('search_emails returns a graceful fallback string when gmail.search throws', async () => {
  const gmail = { search: async () => { throw new Error('network error'); } };
  const executor = createToolExecutor({ wolfram: null, harness: null, gmail, getGoogleCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }) });

  const result = await executor('search_emails', '{"query":"recruiter"}');

  assert.match(result, /not connected|no matching/i);
});

test('list_recent_emails and search_emails fall back gracefully when gmail/getGoogleCredentials are not wired up', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  assert.match(await executor('list_recent_emails', '{}'), /not connected|no matching/i);
  assert.match(await executor('search_emails', '{"query":"x"}'), /not connected|no matching/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/jarvis-tools.test.js`
Expected: FAIL — the tool-name-list assertion fails (only 2 names exist), and the new tests fail because `list_recent_emails`/`search_emails` aren't recognized tool names yet.

- [ ] **Step 3: Implement in `src/jarvis-tools.js`**

Add a new fallback constant near the top, right after `HARNESS_NO_RESULT_PREFIX`:

```js
const NO_EMAIL_RESULT = 'Gmail is not connected or no matching emails were found.';
```

Append two entries to the `GROUNDING_TOOLS` array (after the `web_search` entry, inside the closing `];`):

```js
  {
    type: 'function',
    function: {
      name: 'list_recent_emails',
      description: "Lists the user's most recent Gmail messages (sender, subject, snippet). Use this when the user asks about recent email or their inbox without a specific search term.",
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_emails',
      description: "Searches the user's Gmail for messages matching a query (sender name, subject keywords, or content). Use this to answer questions about a specific email or sender.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms — sender, subject keywords, or content to match.' }
        },
        required: ['query']
      }
    }
  }
```

Change the `createToolExecutor` signature to accept `gmail` and `getGoogleCredentials`:

```js
export function createToolExecutor({ wolfram, harness, gmail, getGoogleCredentials, onLog = () => {} }) {
```

Add two new branches inside `executeTool`, right before the final `onLog({ type: 'WARNING', message: ... Unknown tool ... });` fallback:

```js
    if (name === 'list_recent_emails') {
      try {
        if (!gmail || !getGoogleCredentials) return NO_EMAIL_RESULT;
        const { clientId, clientSecret } = getGoogleCredentials();
        const result = await gmail.listRecent(clientId, clientSecret);
        onLog({ type: 'TOOL', message: `[TOOL CALL] list_recent_emails() -> ${result.success ? `${result.messages.length} message(s)` : 'unavailable'}` });
        return result.success ? result.message : NO_EMAIL_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] list_recent_emails failed: ${e.message}` });
        return NO_EMAIL_RESULT;
      }
    }

    if (name === 'search_emails') {
      const query = args.query || '';
      try {
        if (!gmail || !getGoogleCredentials) return NO_EMAIL_RESULT;
        const { clientId, clientSecret } = getGoogleCredentials();
        const result = await gmail.search(clientId, clientSecret, query);
        onLog({ type: 'TOOL', message: `[TOOL CALL] search_emails("${query}") -> ${result.success ? `${result.messages.length} result(s)` : 'unavailable'}` });
        return result.success ? result.message : NO_EMAIL_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] search_emails failed: ${e.message}` });
        return NO_EMAIL_RESULT;
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/jarvis-tools.test.js`
Expected: PASS (all tests, including the 5 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/jarvis-tools.js test/jarvis-tools.test.js
git commit -m "Add list_recent_emails/search_emails grounding tools for autonomous Gmail lookups"
```

---

## Task 4: Wire GMAIL_* into the AI intent classifier

**Files:**
- Modify: `src/ai-intent-classifier.js`
- Modify: `test/ai-intent-classifier.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/ai-intent-classifier.test.js`:

```js
test('accepts a GMAIL_CHECK_INBOX decision', async () => {
  const result = await classifyIntentWithAI({
    input: 'check my email',
    classifyIntent: async () => JSON.stringify({ toolName: 'GMAIL_CHECK_INBOX', params: {} })
  });
  assert.equal(result.toolName, 'GMAIL_CHECK_INBOX');
});

test('accepts a GMAIL_SEARCH decision with its required query param', async () => {
  const result = await classifyIntentWithAI({
    input: 'search my email for the invoice',
    classifyIntent: async () => JSON.stringify({ toolName: 'GMAIL_SEARCH', params: { query: 'the invoice' } })
  });
  assert.equal(result.toolName, 'GMAIL_SEARCH');
  assert.deepEqual(result.params, { query: 'the invoice' });
});

test('rejects a GMAIL_SEARCH decision missing the required query param', async () => {
  const result = await classifyIntentWithAI({
    input: 'search my email',
    classifyIntent: async () => JSON.stringify({ toolName: 'GMAIL_SEARCH', params: {} })
  });
  assert.equal(result, null);
});

test('accepts a GMAIL_READ_MESSAGE decision with its required query param', async () => {
  const result = await classifyIntentWithAI({
    input: 'read me the email from sarah',
    classifyIntent: async () => JSON.stringify({ toolName: 'GMAIL_READ_MESSAGE', params: { query: 'sarah' } })
  });
  assert.equal(result.toolName, 'GMAIL_READ_MESSAGE');
  assert.deepEqual(result.params, { query: 'sarah' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/ai-intent-classifier.test.js`
Expected: FAIL — `GMAIL_CHECK_INBOX`/`GMAIL_SEARCH`/`GMAIL_READ_MESSAGE` aren't in `TOOL_PARAM_REQUIREMENTS` yet, so `classifyIntentWithAI` returns `null` for all four new tests (the third test expects `null` and will pass by accident; the other three will fail).

- [ ] **Step 3: Implement in `src/ai-intent-classifier.js`**

Add three entries to `TOOL_PARAM_REQUIREMENTS`, right after `SCREEN_QUERY: ['question'],` and before `CONVERSATIONAL: []`:

```js
  GMAIL_CHECK_INBOX: [],
  GMAIL_SEARCH: ['query'],
  GMAIL_READ_MESSAGE: ['query'],
```

Add three lines to `INTENT_CLASSIFIER_SYSTEM_PROMPT`'s tool list, right after `- SCREEN_QUERY: { question: string }` and before `- CONVERSATIONAL: {}`:

```
- GMAIL_CHECK_INBOX: {} — user wants to check their email/inbox generally
- GMAIL_SEARCH: { query: string } — user wants to search their email for something specific
- GMAIL_READ_MESSAGE: { query: string } — user wants JARVIS to read a specific email (by sender or subject) aloud
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/ai-intent-classifier.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/ai-intent-classifier.js test/ai-intent-classifier.test.js
git commit -m "Recognize GMAIL_CHECK_INBOX/GMAIL_SEARCH/GMAIL_READ_MESSAGE in the AI intent classifier"
```

---

## Task 5: Regex fallback detection in the autonomous tool reasoner

**Files:**
- Modify: `src/autonomous-tool-reasoner.js`
- Test: `test/autonomous-tool-reasoner.gmail-detection.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/autonomous-tool-reasoner.gmail-detection.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const checkInboxCases = ['check my email', 'check my inbox', 'check my gmail', 'check email', 'any new email', 'any new emails'];
for (const query of checkInboxCases) {
  test(`classifies "${query}" as GMAIL_CHECK_INBOX`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'GMAIL_CHECK_INBOX');
  });
}

test('classifies "search my email for the invoice" as GMAIL_SEARCH with the parsed query', () => {
  const decision = reasoner.evaluateIntent('search my email for the invoice');
  assert.equal(decision.toolName, 'GMAIL_SEARCH');
  assert.equal(decision.params.query, 'the invoice');
});

test('classifies "find my inbox for receipts" as GMAIL_SEARCH', () => {
  const decision = reasoner.evaluateIntent('find my inbox for receipts');
  assert.equal(decision.toolName, 'GMAIL_SEARCH');
  assert.equal(decision.params.query, 'receipts');
});

test('classifies "read me the email from sarah" as GMAIL_READ_MESSAGE with the parsed sender', () => {
  const decision = reasoner.evaluateIntent('read me the email from sarah');
  assert.equal(decision.toolName, 'GMAIL_READ_MESSAGE');
  assert.equal(decision.params.query, 'sarah');
});

test('classifies "read the message from github" as GMAIL_READ_MESSAGE', () => {
  const decision = reasoner.evaluateIntent('read the message from github');
  assert.equal(decision.toolName, 'GMAIL_READ_MESSAGE');
  assert.equal(decision.params.query, 'github');
});

const nonGmailQueries = [
  'what is the capital of France',
  'play Cyberpunk 2077',
  'switch mode to high',
  'open gmail',
  'open spotify',
  "what's on my screen",
  'open camera'
];
for (const query of nonGmailQueries) {
  test(`does not classify "${query}" as a Gmail command`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.notEqual(decision.toolName, 'GMAIL_CHECK_INBOX');
    assert.notEqual(decision.toolName, 'GMAIL_SEARCH');
    assert.notEqual(decision.toolName, 'GMAIL_READ_MESSAGE');
  });
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/autonomous-tool-reasoner.gmail-detection.test.js`
Expected: FAIL — none of the `GMAIL_*` cases match yet (they fall through to other tool names or `CONVERSATIONAL`); the `nonGmailQueries` loop passes vacuously.

- [ ] **Step 3: Implement in `src/autonomous-tool-reasoner.js`**

Update the `toolName` JSDoc union in the class-level comment (around line 19) to add the three new names before `'CONVERSATIONAL'`:

```
 *    toolName: 'GOOGLE_SEARCH' | 'STEAM_LAUNCH_GAME' | 'STEAM_OPEN_CLIENT' | 'SPOTIFY_PLAY_SONG' | 'SPOTIFY_PLAY_LIBRARY' | 'SPOTIFY_OPEN_CLIENT' | 'EPIC_OPEN_CLIENT' | 'XBOX_OPEN_CLIENT' | 'XBOX_LAUNCH_GAME' | 'EPIC_LAUNCH_GAME' | 'OPEN_SITE' | 'MATH_QUERY' | 'SET_MODEL_TIER' | 'SCREEN_MONITOR_START' | 'SCREEN_MONITOR_STOP' | 'SCREEN_QUERY' | 'CAMERA_START' | 'CAMERA_STOP' | 'CAMERA_QUERY' | 'GMAIL_CHECK_INBOX' | 'GMAIL_SEARCH' | 'GMAIL_READ_MESSAGE' | 'CONVERSATIONAL',
```

Insert a new section "1h" right after the camera query block (after the `cameraQueryPattern` `if` block closes, i.e. right after this existing code:

```js
    const cameraQueryPattern = /what am i holding|how many fingers|what('?s| is) (?:in front of|on) (?:the |my )?camera|what do you see(?: in the camera)?|look at (?:the |my )?camera|can you see me|what am i wearing|what color (?:is this|am i)/i;
    if (cameraQueryPattern.test(text)) {
      return {
        shouldCallTool: true,
        toolName: 'CAMERA_QUERY',
        confidence: 0.85,
        params: { question: input.trim() },
        reasoning: "Autonomous reasoner detected a question about what's visible through the camera."
      };
    }
```

) and before the `// 2. Check for gaming & Steam launch intents` comment, insert:

```js
    // 1h. Check for Gmail commands — same thin fallback-net role as the
    // screen/camera checks above. Checked well before the "gmail" entry in
    // the OPEN_SITE site map (section 6) so "check my email" is never
    // misread as "open gmail.com"; plain "open gmail" still falls through to
    // that site-map entry unchanged, since none of these require "open".
    if (text.match(/^(?:check|any new)\s+(?:my\s+)?(?:emails?|gmail|inbox)[.!]?\s*$/i)) {
      return {
        shouldCallTool: true,
        toolName: 'GMAIL_CHECK_INBOX',
        confidence: 0.93,
        params: {},
        reasoning: "Autonomous reasoner detected intent to check the Gmail inbox."
      };
    }

    const gmailSearchMatch = text.match(/(?:search|find)\s+(?:my\s+)?(?:emails?|gmail|inbox)\s+for\s+(.+)/i);
    if (gmailSearchMatch && gmailSearchMatch[1]) {
      return {
        shouldCallTool: true,
        toolName: 'GMAIL_SEARCH',
        confidence: 0.9,
        params: { query: gmailSearchMatch[1].trim() },
        reasoning: `Autonomous reasoner detected intent to search Gmail for "${gmailSearchMatch[1].trim()}".`
      };
    }

    const gmailReadMatch = text.match(/read\s+(?:me\s+)?(?:the\s+)?(?:email|message)\s+from\s+(.+)/i);
    if (gmailReadMatch && gmailReadMatch[1]) {
      return {
        shouldCallTool: true,
        toolName: 'GMAIL_READ_MESSAGE',
        confidence: 0.88,
        params: { query: gmailReadMatch[1].trim() },
        reasoning: `Autonomous reasoner detected intent to read the email from "${gmailReadMatch[1].trim()}".`
      };
    }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/autonomous-tool-reasoner.gmail-detection.test.js`
Expected: PASS (all tests)

Then run the full reasoner suite to confirm no regressions:

Run: `node --test test/autonomous-tool-reasoner.*.test.js`
Expected: PASS (all files)

- [ ] **Step 5: Commit**

```bash
git add src/autonomous-tool-reasoner.js test/autonomous-tool-reasoner.gmail-detection.test.js
git commit -m "Add regex fallback detection for Gmail check/search/read commands"
```

---

## Task 6: Wire `GmailHarness`/`GoogleAccountConnector` into `JarvisCore`

**Files:**
- Modify: `src/jarvis-core.js`
- Test: `test/jarvis-core.gmail-routing.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/jarvis-core.gmail-routing.test.js`:

```js
/**
 * Tests that Gmail commands are routed to GmailHarness and the harness's
 * spoken message is what actually gets spoken — no LLM involvement either
 * way. Mirrors jarvis-core.spotify-routing.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('"check my email" checks the inbox via GmailHarness and speaks its message', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.gmailHarness.listRecent = async (clientId, clientSecret) => {
    calls.push({ clientId, clientSecret });
    return { success: true, messages: [], message: 'Your inbox has no recent messages, Sir.' };
  };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('check my email');

  assert.equal(calls.length, 1);
  assert.equal(jarvis.llmCalls.length, 0);
  assert.deepEqual(spoken, ['Your inbox has no recent messages, Sir.']);
});

test('"search my email for the invoice" calls search with the parsed query', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.gmailHarness.search = async (clientId, clientSecret, query) => {
    calls.push(query);
    return { success: true, messages: [], message: `I didn't find any emails matching "${query}", Sir.` };
  };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('search my email for the invoice');

  assert.deepEqual(calls, ['the invoice']);
  assert.deepEqual(spoken, ['I didn\'t find any emails matching "the invoice", Sir.']);
});

test('"read me the email from sarah" calls readMessage with the parsed sender', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.gmailHarness.readMessage = async (clientId, clientSecret, query) => {
    calls.push(query);
    return { success: true, message: 'From Sarah, subject "Trip plans": Let\'s go next week.' };
  };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('read me the email from sarah');

  assert.deepEqual(calls, ['sarah']);
  assert.deepEqual(spoken, ['From Sarah, subject "Trip plans": Let\'s go next week.']);
});

test('a Gmail harness failure result is still spoken as-is, not treated as a crash', async () => {
  const jarvis = createJarvis();
  jarvis.gmailHarness.listRecent = async () => ({ success: false, message: "Your Google account isn't connected yet. Connect it in Settings, Sir." });
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('check my email');

  assert.deepEqual(spoken, ["Your Google account isn't connected yet. Connect it in Settings, Sir."]);
});

test('a non-Gmail query never calls GmailHarness', async () => {
  const jarvis = createJarvis();
  jarvis.gmailCalls = [];
  jarvis.gmailHarness.listRecent = async () => { jarvis.gmailCalls.push('listRecent'); return { success: true, message: '' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.gmailCalls.length, 0);
});

test('JarvisCore constructor wires this.googleClientId/this.googleClientSecret from localStorage', async () => {
  global.localStorage.setItem('jarvis_google_client_id', 'stored-id');
  global.localStorage.setItem('jarvis_google_client_secret', 'stored-secret');
  const jarvis = createJarvis();
  assert.equal(jarvis.googleClientId, 'stored-id');
  assert.equal(jarvis.googleClientSecret, 'stored-secret');
  global.localStorage.removeItem('jarvis_google_client_id');
  global.localStorage.removeItem('jarvis_google_client_secret');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/jarvis-core.gmail-routing.test.js`
Expected: FAIL — `jarvis.gmailHarness` is `undefined` (`Cannot read properties of undefined`), and `jarvis.googleClientId` is `undefined`.

- [ ] **Step 3: Implement in `src/jarvis-core.js`**

Add two imports after the existing `import { GROUNDING_TOOLS, createToolExecutor } from './jarvis-tools.js';` line:

```js
import { GoogleAccountConnector } from './google-account-connector.js';
import { GmailHarness } from './gmail-harness.js';
```

In the constructor, right after the `this.spotifyHarness = new SpotifyHarness({...});` block (before `this.epicGamesLibrary = new EpicGamesLibrary({...});`), add:

```js
    // Google account credentials are optional — without them connected,
    // GmailHarness methods return a "connect your account in Settings"
    // message instead of hitting the network. See
    // docs/superpowers/specs/2026-08-15-gmail-google-connector-design.md.
    this.googleClientId = localStorage.getItem('jarvis_google_client_id') || '';
    this.googleClientSecret = localStorage.getItem('jarvis_google_client_secret') || '';

    this.googleAccountConnector = new GoogleAccountConnector({
      onLog: (logData) => this.onLog(logData)
    });

    this.gmailHarness = new GmailHarness({
      onLog: (logData) => this.onLog(logData)
    });
```

Update the `this.toolExecutor = createToolExecutor({...})` call to pass the new Gmail wiring:

```js
    this.toolExecutor = createToolExecutor({
      wolfram: this.wolfram,
      harness: this.harness,
      gmail: this.gmailHarness,
      getGoogleCredentials: () => ({ clientId: this.googleClientId, clientSecret: this.googleClientSecret }),
      onLog: (logData) => this.onLog(logData)
    });
```

Add a capabilities line to the `knowledgeBase` object, right after the `"spotify": "..."` entry:

```js
      "gmail": "Gmail harness is ready. If your Google account is connected in Settings, I can check your inbox, search your email, or read a specific message by sender or subject.",
```

Add three new dispatch blocks in `processUserInput`, right after the existing "8g. Handle Camera Vision Questions" block (after its closing `}` and `return;`) and before the `// 9. Conversational Response` comment:

```js
    // 8h. Handle Gmail Inbox Check ("check my email")
    if (decision.toolName === 'GMAIL_CHECK_INBOX') {
      this._updateAgentState("agent-3", "EXECUTING", "Checking Gmail inbox");
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.gmailHarness.listRecent(this.googleClientId, this.googleClientSecret);

      this.onResponse({ text: result.message, actionType: 'GMAIL_CHECK_INBOX', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Inbox checked" : "Gmail unavailable");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8i. Handle Gmail Search ("search my email for the invoice")
    if (decision.toolName === 'GMAIL_SEARCH') {
      this._updateAgentState("agent-3", "EXECUTING", `Searching Gmail: "${decision.params.query}"`);
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.gmailHarness.search(this.googleClientId, this.googleClientSecret, decision.params.query);

      this.onResponse({ text: result.message, actionType: 'GMAIL_SEARCH', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Gmail search complete" : "Gmail unavailable");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8j. Handle Gmail Read Message ("read me the email from Sarah")
    if (decision.toolName === 'GMAIL_READ_MESSAGE') {
      this._updateAgentState("agent-3", "EXECUTING", `Reading Gmail message: "${decision.params.query}"`);
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.gmailHarness.readMessage(this.googleClientId, this.googleClientSecret, decision.params.query);

      this.onResponse({ text: result.message, actionType: 'GMAIL_READ_MESSAGE', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Gmail message read" : "Gmail unavailable");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/jarvis-core.gmail-routing.test.js`
Expected: PASS (all 6 tests)

Then run the full suite to confirm no regressions:

Run: `npm test`
Expected: PASS (every test file, including all pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add src/jarvis-core.js test/jarvis-core.gmail-routing.test.js
git commit -m "Wire GmailHarness/GoogleAccountConnector into JarvisCore's dispatch and grounding-tool paths"
```

---

## Task 7: Electron main-process Google OAuth + Gmail API

**Files:**
- Modify: `electron/main.cjs`

This task has no automated tests — `main.cjs` requires the `electron` module at import time, so it can't be loaded under plain `node --test` the way every other file in this codebase can (the existing Spotify OAuth code in this same file has the same limitation and is likewise untested). Verify each step with `node --check` (syntax only) and do the real verification via the manual smoke test in Task 10.

- [ ] **Step 1: Add Google OAuth constants**

In `electron/main.cjs`, right after the existing block:

```js
const SPOTIFY_REDIRECT_PORT = 43417;
const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}/callback`;
const SPOTIFY_AUTH_SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';
```

insert:

```js

// Local loopback redirect for Google's OAuth 2.0 Authorization Code + PKCE
// flow — this exact URI must be added to the "Authorized redirect URIs" of
// the Desktop-app OAuth client in Google Cloud Console for login to work.
// Read-only scope only: no send/modify/delete requested, so even a leaked
// token can't act on the mailbox, only read it (see
// docs/superpowers/specs/2026-08-15-gmail-google-connector-design.md).
const GOOGLE_REDIRECT_PORT = 43418;
const GOOGLE_REDIRECT_URI = `http://127.0.0.1:${GOOGLE_REDIRECT_PORT}/callback`;
const GOOGLE_AUTH_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly openid email profile';
```

Verify: `node --check electron/main.cjs` → no output (syntax OK).

- [ ] **Step 2: Add token storage, OAuth exchange, and Gmail API helpers**

Right after the closing `}` of `registerSpotifyAuthIpc()` (i.e. right before the `function sendUpdateState(state) {` line), insert this entire new section:

```js
// --- Google account connection (Authorization Code + PKCE OAuth) ---------
// Gives JARVIS read access to the user's own Gmail — see
// docs/superpowers/specs/2026-08-15-gmail-google-connector-design.md.
// Tokens are encrypted at rest via Electron's safeStorage, same as Spotify.
function googleTokensPath() {
  return path.join(app.getPath('userData'), 'google-tokens.bin');
}

function loadGoogleTokens() {
  try {
    const tokenPath = googleTokensPath();
    if (!fs.existsSync(tokenPath) || !safeStorage.isEncryptionAvailable()) return null;
    const decrypted = safeStorage.decryptString(fs.readFileSync(tokenPath));
    return JSON.parse(decrypted);
  } catch (e) {
    return null;
  }
}

function saveGoogleTokens(tokens) {
  if (!safeStorage.isEncryptionAvailable()) return;
  fs.writeFileSync(googleTokensPath(), safeStorage.encryptString(JSON.stringify(tokens)));
}

function clearGoogleTokens() {
  try {
    const tokenPath = googleTokensPath();
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
  } catch (e) {}
}

// Google's token endpoint takes client_id/client_secret as plain POST body
// fields (unlike Spotify's HTTP Basic auth header).
function googleTokenRequest(bodyParams) {
  const body = new URLSearchParams(bodyParams).toString();

  return new Promise((resolve, reject) => {
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          reject(new Error('Invalid Google token response'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(parsed?.error_description || parsed?.error || `Google token exchange HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getValidGoogleAccessToken(clientId, clientSecret) {
  const tokens = loadGoogleTokens();
  if (!tokens || !tokens.refresh_token) return null;

  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }

  const refreshed = await googleTokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    client_secret: clientSecret
  });

  const updated = {
    access_token: refreshed.access_token,
    refresh_token: tokens.refresh_token, // Google does not re-issue this on refresh
    expires_at: Date.now() + refreshed.expires_in * 1000
  };
  saveGoogleTokens(updated);
  return updated.access_token;
}

function gmailApiGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${accessToken}` } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let reason = data;
          try { reason = JSON.parse(data)?.error?.message || data; } catch (e) {}
          reject(new Error(`Gmail API HTTP ${res.statusCode}: ${reason}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid Gmail API response'));
        }
      });
    }).on('error', reject);
  });
}

function extractGmailHeader(headers, name) {
  const found = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

async function fetchGmailMessageSummary(id, accessToken) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
  const data = await gmailApiGet(url, accessToken);
  const headers = data.payload?.headers || [];
  return {
    id: data.id,
    from: extractGmailHeader(headers, 'From'),
    subject: extractGmailHeader(headers, 'Subject'),
    date: extractGmailHeader(headers, 'Date'),
    snippet: data.snippet || ''
  };
}

async function listGmailMessages(accessToken, { q, maxResults = 10 } = {}) {
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (q) params.set('q', q);
  const listData = await gmailApiGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`, accessToken);
  const ids = (listData.messages || []).map((m) => m.id);
  return Promise.all(ids.map((id) => fetchGmailMessageSummary(id, accessToken)));
}

function decodeGmailBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// Recursively finds the first text/plain part in a (possibly multipart)
// Gmail message payload; falls back to a stripped text/html part if no
// plain-text part exists.
function findGmailPlainTextPart(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeGmailBase64Url(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findGmailPlainTextPart(part);
      if (found) return found;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeGmailBase64Url(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

async function fetchGmailFullMessage(id, accessToken) {
  const data = await gmailApiGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, accessToken);
  const headers = data.payload?.headers || [];
  const body = findGmailPlainTextPart(data.payload) || data.snippet || '';
  return {
    id: data.id,
    from: extractGmailHeader(headers, 'From'),
    subject: extractGmailHeader(headers, 'Subject'),
    date: extractGmailHeader(headers, 'Date'),
    // Truncated so a long email doesn't get read back verbatim word-for-word.
    body: body.length > 2000 ? body.slice(0, 2000) + '…' : body
  };
}

function registerGoogleAuthIpc() {
  ipcMain.handle('google:auth-status', () => {
    const tokens = loadGoogleTokens();
    return { authenticated: !!(tokens && tokens.refresh_token) };
  });

  ipcMain.handle('google:logout', () => {
    clearGoogleTokens();
    return { success: true };
  });

  // Authorization Code + PKCE flow via a local loopback HTTP server, same
  // pattern as Spotify above. access_type=offline + prompt=consent guarantee
  // a refresh_token comes back (Google only issues one on first consent
  // otherwise). code_verifier/code_challenge are PKCE — Google's Desktop-app
  // OAuth clients get a client_secret too, but Google's own docs note it
  // isn't a true secret for installed apps, so PKCE is the real protection.
  ipcMain.handle('google:authorize', (event, { clientId, clientSecret }) => {
    if (!clientId || !clientSecret) {
      return Promise.reject(new Error('Google Client ID and Secret are required to connect your account.'));
    }

    return new Promise((resolve, reject) => {
      const state = crypto.randomBytes(16).toString('hex');
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      let settled = false;
      let server;

      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { server.close(); } catch (e) {}
        fn(arg);
      };

      const timeout = setTimeout(() => {
        finish(reject, new Error('Google login timed out. Please try again.'));
      }, 120000);

      server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${GOOGLE_REDIRECT_PORT}`);
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const authError = reqUrl.searchParams.get('error');
        const ok = !authError && code && returnedState === state;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<html><body style="font-family:sans-serif;background:#05070c;color:${ok ? '#39ff14' : '#ff3b3b'};text-align:center;padding-top:80px">` +
          `<h2>JARVIS: Google account ${ok ? 'connected' : 'connection failed'}.</h2>` +
          `<p style="color:#8899aa">You can close this tab and return to JARVIS.</p></body></html>`
        );

        if (!ok) {
          finish(reject, new Error(authError ? `Google authorization denied: ${authError}` : 'Invalid Google authorization response.'));
          return;
        }

        googleTokenRequest({
          grant_type: 'authorization_code',
          code,
          redirect_uri: GOOGLE_REDIRECT_URI,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: codeVerifier
        }).then((tokenResp) => {
          if (!tokenResp.refresh_token) {
            finish(reject, new Error("Google did not return a refresh token. Remove JARVIS from your Google Account's connected apps and try again."));
            return;
          }
          saveGoogleTokens({
            access_token: tokenResp.access_token,
            refresh_token: tokenResp.refresh_token,
            expires_at: Date.now() + tokenResp.expires_in * 1000
          });
          finish(resolve, { success: true });
        }).catch((err) => finish(reject, err));
      });

      server.on('error', (err) => {
        finish(reject, new Error(`Could not start local Google login server: ${err.message}`));
      });

      server.listen(GOOGLE_REDIRECT_PORT, '127.0.0.1', () => {
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: GOOGLE_REDIRECT_URI,
          scope: GOOGLE_AUTH_SCOPES,
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state
        }).toString();
        shell.openExternal(authUrl);
      });
    });
  });

  ipcMain.handle('gmail:list-messages', async (event, { clientId, clientSecret, maxResults }) => {
    const accessToken = await getValidGoogleAccessToken(clientId, clientSecret);
    if (!accessToken) throw new Error('Not connected to Google. Please connect your account first.');
    return listGmailMessages(accessToken, { maxResults });
  });

  ipcMain.handle('gmail:search-messages', async (event, { clientId, clientSecret, query, maxResults }) => {
    const accessToken = await getValidGoogleAccessToken(clientId, clientSecret);
    if (!accessToken) throw new Error('Not connected to Google. Please connect your account first.');
    return listGmailMessages(accessToken, { q: query, maxResults });
  });

  ipcMain.handle('gmail:get-message', async (event, { clientId, clientSecret, id }) => {
    const accessToken = await getValidGoogleAccessToken(clientId, clientSecret);
    if (!accessToken) throw new Error('Not connected to Google. Please connect your account first.');
    return fetchGmailFullMessage(id, accessToken);
  });
}

```

Verify: `node --check electron/main.cjs` → no output (syntax OK).

- [ ] **Step 3: Register the new IPC handlers at startup**

Find:

```js
  registerSpotifyAuthIpc();
  registerUpdaterEvents();
```

Replace with:

```js
  registerSpotifyAuthIpc();
  registerGoogleAuthIpc();
  registerUpdaterEvents();
```

Verify: `node --check electron/main.cjs` → no output (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add electron/main.cjs
git commit -m "Add Google OAuth (PKCE) and Gmail API IPC handlers to the Electron main process"
```

---

## Task 8: Electron preload bridge

**Files:**
- Modify: `electron/preload.cjs`

No automated tests for this file either (same reasoning as Task 7 — it only runs inside Electron's preload context). Verify with `node --check`.

- [ ] **Step 1: Add the googleAuth/gmail bridges**

Find:

```js
  spotifyAuth: {
    status: () => ipcRenderer.invoke('spotify:auth-status'),
    login: (clientId, clientSecret) => ipcRenderer.invoke('spotify:authorize', { clientId, clientSecret }),
    logout: () => ipcRenderer.invoke('spotify:logout'),
    getLibrary: (clientId, clientSecret) => ipcRenderer.invoke('spotify:get-library', { clientId, clientSecret })
  },
```

Replace with:

```js
  spotifyAuth: {
    status: () => ipcRenderer.invoke('spotify:auth-status'),
    login: (clientId, clientSecret) => ipcRenderer.invoke('spotify:authorize', { clientId, clientSecret }),
    logout: () => ipcRenderer.invoke('spotify:logout'),
    getLibrary: (clientId, clientSecret) => ipcRenderer.invoke('spotify:get-library', { clientId, clientSecret })
  },
  googleAuth: {
    status: () => ipcRenderer.invoke('google:auth-status'),
    login: (clientId, clientSecret) => ipcRenderer.invoke('google:authorize', { clientId, clientSecret }),
    logout: () => ipcRenderer.invoke('google:logout')
  },
  gmail: {
    listMessages: (clientId, clientSecret, maxResults) => ipcRenderer.invoke('gmail:list-messages', { clientId, clientSecret, maxResults }),
    search: (clientId, clientSecret, query, maxResults) => ipcRenderer.invoke('gmail:search-messages', { clientId, clientSecret, query, maxResults }),
    getMessage: (clientId, clientSecret, id) => ipcRenderer.invoke('gmail:get-message', { clientId, clientSecret, id })
  },
```

Verify: `node --check electron/preload.cjs` → no output (syntax OK).

- [ ] **Step 2: Commit**

```bash
git add electron/preload.cjs
git commit -m "Expose googleAuth/gmail IPC bridges to the renderer via preload"
```

---

## Task 9: Settings UI markup

**Files:**
- Modify: `index.html`

No automated tests (no existing HTML/UI test harness in this codebase). Verified manually in Task 10.

- [ ] **Step 1: Add API-key inputs and a Google Cloud Console link**

Find:

```html
          <a href="https://developer.spotify.com/dashboard" target="_blank">Get Spotify Client ID/Secret</a>
          (optional, lets JARVIS play the exact song instead of just opening search)
        </div>
        <input type="password" id="openrouterKeyInput" class="steam-input" placeholder="OpenRouter API Key" autocomplete="off" />
        <input type="password" id="groqKeyInput" class="steam-input" placeholder="Groq API Key (optional, get one at console.groq.com/keys)" autocomplete="off" />
        <input type="password" id="geminiKeyInput" class="steam-input" placeholder="Gemini API Key (required for Ultra tier, get one at aistudio.google.com/apikey)" autocomplete="off" />
        <input type="password" id="deepgramKeyInput" class="steam-input" placeholder="Deepgram API Key (optional)" autocomplete="off" />
        <input type="password" id="wolframKeyInput" class="steam-input" placeholder="WolframAlpha AppID (optional, get one free at products.wolframalpha.com/api)" autocomplete="off" />
        <input type="password" id="spotifyClientIdInput" class="steam-input" placeholder="Spotify Client ID (optional, developer.spotify.com/dashboard)" autocomplete="off" />
        <input type="password" id="spotifyClientSecretInput" class="steam-input" placeholder="Spotify Client Secret (optional)" autocomplete="off" />
        <div class="settings-hint">Restart JARVIS after adding/changing the Deepgram key to activate it.</div>
```

Replace with:

```html
          <a href="https://developer.spotify.com/dashboard" target="_blank">Get Spotify Client ID/Secret</a>
          (optional, lets JARVIS play the exact song instead of just opening search) ·
          <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Get a Google Client ID/Secret</a>
          (optional, lets JARVIS check/search/read your Gmail — see Google Account below)
        </div>
        <input type="password" id="openrouterKeyInput" class="steam-input" placeholder="OpenRouter API Key" autocomplete="off" />
        <input type="password" id="groqKeyInput" class="steam-input" placeholder="Groq API Key (optional, get one at console.groq.com/keys)" autocomplete="off" />
        <input type="password" id="geminiKeyInput" class="steam-input" placeholder="Gemini API Key (required for Ultra tier, get one at aistudio.google.com/apikey)" autocomplete="off" />
        <input type="password" id="deepgramKeyInput" class="steam-input" placeholder="Deepgram API Key (optional)" autocomplete="off" />
        <input type="password" id="wolframKeyInput" class="steam-input" placeholder="WolframAlpha AppID (optional, get one free at products.wolframalpha.com/api)" autocomplete="off" />
        <input type="password" id="spotifyClientIdInput" class="steam-input" placeholder="Spotify Client ID (optional, developer.spotify.com/dashboard)" autocomplete="off" />
        <input type="password" id="spotifyClientSecretInput" class="steam-input" placeholder="Spotify Client Secret (optional)" autocomplete="off" />
        <input type="password" id="googleClientIdInput" class="steam-input" placeholder="Google Client ID (optional, console.cloud.google.com/apis/credentials)" autocomplete="off" />
        <input type="password" id="googleClientSecretInput" class="steam-input" placeholder="Google Client Secret (optional)" autocomplete="off" />
        <div class="settings-hint">Restart JARVIS after adding/changing the Deepgram key to activate it.</div>
```

- [ ] **Step 2: Add the Google Account settings section**

Find:

```html
      <div class="settings-section" id="spotifyAccountSection" style="display: none;">
        <div class="settings-section-title">🎵 Spotify Account</div>
        <div class="settings-hint">
          Connect your own Spotify account so JARVIS can play your saved playlists and
          albums by name (e.g. "play my Chill playlist") and your Liked Songs. Requires a
          Spotify Client ID/Secret above, and this exact Redirect URI added under your
          app's settings on the
          <a href="https://developer.spotify.com/dashboard" target="_blank">Spotify Developer Dashboard</a>:
          <code>http://127.0.0.1:43417/callback</code>
        </div>
        <div class="settings-row">
          <span id="spotifyAccountStatus">Not connected</span>
        </div>
        <button class="btn-steam-save" id="spotifyConnectBtn">CONNECT SPOTIFY ACCOUNT</button>
        <button class="btn-steam-save" id="spotifyDisconnectBtn" style="display: none;">DISCONNECT</button>
      </div>
```

Replace with:

```html
      <div class="settings-section" id="spotifyAccountSection" style="display: none;">
        <div class="settings-section-title">🎵 Spotify Account</div>
        <div class="settings-hint">
          Connect your own Spotify account so JARVIS can play your saved playlists and
          albums by name (e.g. "play my Chill playlist") and your Liked Songs. Requires a
          Spotify Client ID/Secret above, and this exact Redirect URI added under your
          app's settings on the
          <a href="https://developer.spotify.com/dashboard" target="_blank">Spotify Developer Dashboard</a>:
          <code>http://127.0.0.1:43417/callback</code>
        </div>
        <div class="settings-row">
          <span id="spotifyAccountStatus">Not connected</span>
        </div>
        <button class="btn-steam-save" id="spotifyConnectBtn">CONNECT SPOTIFY ACCOUNT</button>
        <button class="btn-steam-save" id="spotifyDisconnectBtn" style="display: none;">DISCONNECT</button>
      </div>

      <div class="settings-section" id="googleAccountSection" style="display: none;">
        <div class="settings-section-title">📧 Google Account</div>
        <div class="settings-hint">
          Connect your Google account (read-only) so JARVIS can check, search, and read
          your Gmail (e.g. "check my email", "read me the email from Sarah"). Requires a
          Google Client ID/Secret above (Desktop app type), and this exact Redirect URI
          added under "Authorized redirect URIs" for that OAuth client in the
          <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a>:
          <code>http://127.0.0.1:43418/callback</code>
          Only read access is requested — JARVIS can never send, delete, or modify anything
          in your mailbox.
        </div>
        <div class="settings-row">
          <span id="googleAccountStatus">Not connected</span>
        </div>
        <button class="btn-steam-save" id="googleConnectBtn">CONNECT GOOGLE ACCOUNT</button>
        <button class="btn-steam-save" id="googleDisconnectBtn" style="display: none;">DISCONNECT</button>
      </div>
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add Google account Settings UI (API key inputs + connect/disconnect section)"
```

---

## Task 10: Settings UI wiring in `main.js`

**Files:**
- Modify: `src/main.js`

No automated tests (same reasoning as Task 9). Verified in this task's final manual smoke test.

- [ ] **Step 1: Read/save the Google Client ID/Secret in `initSettingsPanel`**

Find:

```js
  const spotifyClientIdInput = document.getElementById('spotifyClientIdInput');
  const spotifyClientSecretInput = document.getElementById('spotifyClientSecretInput');
  const apiKeysSaveBtn = document.getElementById('apiKeysSaveBtn');
```

Replace with:

```js
  const spotifyClientIdInput = document.getElementById('spotifyClientIdInput');
  const spotifyClientSecretInput = document.getElementById('spotifyClientSecretInput');
  const googleClientIdInput = document.getElementById('googleClientIdInput');
  const googleClientSecretInput = document.getElementById('googleClientSecretInput');
  const apiKeysSaveBtn = document.getElementById('apiKeysSaveBtn');
```

Find:

```js
  if (spotifyClientSecretInput && localStorage.getItem('jarvis_spotify_client_secret')) {
    spotifyClientSecretInput.placeholder = '••••••••••••••••• (saved)';
  }
```

Replace with:

```js
  if (spotifyClientSecretInput && localStorage.getItem('jarvis_spotify_client_secret')) {
    spotifyClientSecretInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (googleClientIdInput && localStorage.getItem('jarvis_google_client_id')) {
    googleClientIdInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (googleClientSecretInput && localStorage.getItem('jarvis_google_client_secret')) {
    googleClientSecretInput.placeholder = '••••••••••••••••• (saved)';
  }
```

Find:

```js
      const spotifyClientId = spotifyClientIdInput ? spotifyClientIdInput.value.trim() : '';
      const spotifyClientSecret = spotifyClientSecretInput ? spotifyClientSecretInput.value.trim() : '';
```

Replace with:

```js
      const spotifyClientId = spotifyClientIdInput ? spotifyClientIdInput.value.trim() : '';
      const spotifyClientSecret = spotifyClientSecretInput ? spotifyClientSecretInput.value.trim() : '';
      const googleClientId = googleClientIdInput ? googleClientIdInput.value.trim() : '';
      const googleClientSecret = googleClientSecretInput ? googleClientSecretInput.value.trim() : '';
```

Find:

```js
      if (spotifyClientSecret) {
        localStorage.setItem('jarvis_spotify_client_secret', spotifyClientSecret);
        if (jarvis) jarvis.spotifyClientSecret = spotifyClientSecret;
        spotifyClientSecretInput.value = '';
        spotifyClientSecretInput.placeholder = '••••••••••••••••• (saved)';
      }

      if (apiKeysStatus) {
        if (openrouterKey || groqKey || geminiKey || deepgramKey || wolframAppId || spotifyClientId || spotifyClientSecret) {
```

Replace with:

```js
      if (spotifyClientSecret) {
        localStorage.setItem('jarvis_spotify_client_secret', spotifyClientSecret);
        if (jarvis) jarvis.spotifyClientSecret = spotifyClientSecret;
        spotifyClientSecretInput.value = '';
        spotifyClientSecretInput.placeholder = '••••••••••••••••• (saved)';
      }
      if (googleClientId) {
        localStorage.setItem('jarvis_google_client_id', googleClientId);
        if (jarvis) jarvis.googleClientId = googleClientId;
        googleClientIdInput.value = '';
        googleClientIdInput.placeholder = '••••••••••••••••• (saved)';
      }
      if (googleClientSecret) {
        localStorage.setItem('jarvis_google_client_secret', googleClientSecret);
        if (jarvis) jarvis.googleClientSecret = googleClientSecret;
        googleClientSecretInput.value = '';
        googleClientSecretInput.placeholder = '••••••••••••••••• (saved)';
      }

      if (apiKeysStatus) {
        if (openrouterKey || groqKey || geminiKey || deepgramKey || wolframAppId || spotifyClientId || spotifyClientSecret || googleClientId || googleClientSecret) {
```

- [ ] **Step 2: Add `getSavedGoogleCredentials()` and `initGoogleAccountPanel()`**

Find:

```js
/**
 * Wires the Settings modal's "Spotify Account" section to SpotifyHarness's
 * OAuth methods (which themselves wrap electron/preload.cjs -> electron/main.cjs).
 * Hidden entirely outside Electron, since the OAuth loopback server only runs
 * in the main process.
 */
function initSpotifyAccountPanel() {
```

Insert immediately before it:

```js
/**
 * Reads the currently-saved Google Client ID/Secret the same way
 * JarvisCore does (Settings-saved localStorage values) — kept local rather
 * than reading off the `jarvis` instance since these panels can init before
 * it's constructed.
 */
function getSavedGoogleCredentials() {
  const clientId = localStorage.getItem('jarvis_google_client_id') || '';
  const clientSecret = localStorage.getItem('jarvis_google_client_secret') || '';
  return { clientId, clientSecret };
}

```

Then, after the closing `}` of `initSpotifyAccountPanel()` (right before the `/**\n * Wires the Settings modal's "Software Update" section...` comment), insert a new function:

```js
/**
 * Wires the Settings modal's "Google Account" section to
 * GoogleAccountConnector's OAuth methods (which wrap electron/preload.cjs ->
 * electron/main.cjs). Hidden entirely outside Electron, since the OAuth
 * loopback server only runs in the main process. Mirrors
 * initSpotifyAccountPanel() exactly.
 */
function initGoogleAccountPanel() {
  if (typeof window === 'undefined' || !window.jarvisElectron?.googleAuth || !jarvis) return;

  const section = document.getElementById('googleAccountSection');
  const statusEl = document.getElementById('googleAccountStatus');
  const connectBtn = document.getElementById('googleConnectBtn');
  const disconnectBtn = document.getElementById('googleDisconnectBtn');

  if (!section || !connectBtn) return;
  section.style.display = '';

  const render = (authenticated) => {
    if (statusEl) {
      statusEl.textContent = authenticated ? '✅ Connected' : 'Not connected';
      statusEl.style.color = authenticated ? '#39ff14' : 'var(--text-dim)';
    }
    connectBtn.style.display = authenticated ? 'none' : '';
    if (disconnectBtn) disconnectBtn.style.display = authenticated ? '' : 'none';
  };

  jarvis.googleAccountConnector.authStatus().then(({ authenticated }) => render(authenticated));

  connectBtn.addEventListener('click', async () => {
    const { clientId, clientSecret } = getSavedGoogleCredentials();
    if (!clientId || !clientSecret) {
      if (statusEl) {
        statusEl.textContent = 'Save a Google Client ID/Secret above first.';
        statusEl.style.color = '#ff9f1c';
      }
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = 'CONNECTING… (check your browser)';
    if (statusEl) {
      statusEl.textContent = 'Approve access in the browser tab that just opened…';
      statusEl.style.color = 'var(--text-dim)';
    }

    try {
      await jarvis.googleAccountConnector.login(clientId, clientSecret);
      render(true);
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Connection failed: ${err.message}`;
        statusEl.style.color = '#ff3b3b';
      }
      render(false);
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'CONNECT GOOGLE ACCOUNT';
    }
  });

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      await jarvis.googleAccountConnector.logout();
      render(false);
    });
  }
}

```

- [ ] **Step 3: Call `initGoogleAccountPanel()` at startup**

Find:

```js
  // 8c2. Spotify Account Connection Panel (Electron-only — OAuth needs the
  // main-process loopback server)
  initSpotifyAccountPanel();
```

Replace with:

```js
  // 8c2. Spotify Account Connection Panel (Electron-only — OAuth needs the
  // main-process loopback server)
  initSpotifyAccountPanel();

  // 8c3. Google Account Connection Panel (Electron-only — OAuth needs the
  // main-process loopback server)
  initGoogleAccountPanel();
```

- [ ] **Step 4: Verify syntax and run the full test suite**

Run: `node --check src/main.js`
Expected: no output (syntax OK)

Run: `npm test`
Expected: PASS (every test file — this task touched no test-covered logic, this just confirms nothing else broke)

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "Wire the Google Account Settings panel to GoogleAccountConnector"
```

---

## Task 11: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the intro line**

Find:

```markdown
A desktop voice assistant with wake-word listening ("Jarvis" / "Hey Jarvis"),
OpenRouter/Groq-powered conversation, Google search automation, WolframAlpha-
grounded math, a Steam game launcher, a Spotify launcher, and self-updating
via GitHub Releases — built as an Electron app with a HUD-style web UI.
```

Replace with:

```markdown
A desktop voice assistant with wake-word listening ("Jarvis" / "Hey Jarvis"),
OpenRouter/Groq-powered conversation, Google search automation, WolframAlpha-
grounded math, a Steam game launcher, a Spotify launcher, read-only Gmail
access, and self-updating via GitHub Releases — built as an Electron app
with a HUD-style web UI.
```

- [ ] **Step 2: Add a row to the API keys table**

Find:

```markdown
| `VITE_SPOTIFY_CLIENT_ID` + `VITE_SPOTIFY_CLIENT_SECRET` | Optional — resolves the exact track so "play X on Spotify" auto-plays instead of just opening a search | https://developer.spotify.com/dashboard |
```

Replace with:

```markdown
| `VITE_SPOTIFY_CLIENT_ID` + `VITE_SPOTIFY_CLIENT_SECRET` | Optional — resolves the exact track so "play X on Spotify" auto-plays instead of just opening a search | https://developer.spotify.com/dashboard |
| `VITE_GOOGLE_CLIENT_ID` + `VITE_GOOGLE_CLIENT_SECRET` | Optional — lets JARVIS check/search/read your Gmail (read-only) | https://console.cloud.google.com/apis/credentials |
```

- [ ] **Step 3: Mention Gmail in the Settings/API Keys bullet**

Find:

```markdown
- **API Keys** — OpenRouter, Groq, Deepgram, WolframAlpha, and Spotify, as
  described above. OpenRouter, Groq, WolframAlpha, and Spotify key changes
  apply immediately; a newly added Deepgram key requires restarting JARVIS to
  take effect. Without a WolframAlpha key, math questions ("what is 5 plus 3",
  "square root of 144") are answered by whichever LLM is active instead —
  still works, just not guaranteed to be arithmetically correct. Without a
  Spotify Client ID/Secret (or when running outside the packaged Electron
  app), "play X on Spotify" opens the Spotify app pre-searched for X instead
  of auto-playing the exact track.
```

Replace with:

```markdown
- **API Keys** — OpenRouter, Groq, Deepgram, WolframAlpha, Spotify, and
  Google, as described above. OpenRouter, Groq, WolframAlpha, Spotify, and
  Google key changes apply immediately; a newly added Deepgram key requires
  restarting JARVIS to take effect. Without a WolframAlpha key, math
  questions ("what is 5 plus 3", "square root of 144") are answered by
  whichever LLM is active instead — still works, just not guaranteed to be
  arithmetically correct. Without a Spotify Client ID/Secret (or when running
  outside the packaged Electron app), "play X on Spotify" opens the Spotify
  app pre-searched for X instead of auto-playing the exact track. Without a
  connected Google account, Gmail commands ("check my email") prompt you to
  connect one in Settings instead of failing silently.
```

- [ ] **Step 4: Add a "Google Account / Gmail" section**

Find:

```markdown
## Camera Vision
```

Insert immediately before it:

```markdown
## Google Account / Gmail

JARVIS can check, search, and read your Gmail — read-only, nothing is ever
sent, deleted, or modified.

**Setup (one-time, in Google Cloud Console):**

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/projectcreate)
   (or reuse an existing one).
2. Enable the **Gmail API** under APIs & Services → Library.
3. Configure the **OAuth consent screen** (External is fine for personal
   use) and add your own Google account as a test user.
4. Under APIs & Services → Credentials, create an **OAuth client ID** of
   type **Desktop app**. Copy the generated Client ID and Client Secret.
5. Under that same client's settings, add this exact **Authorized redirect
   URI**: `http://127.0.0.1:43418/callback`
6. In JARVIS, open **⚙️ SETTINGS**, paste the Client ID/Secret into the API
   Keys section, click **SAVE KEYS**, then click **CONNECT GOOGLE ACCOUNT**
   in the Google Account section and approve access in the browser tab that
   opens.

**Voice/text commands:**

- **"Check my email"** — reads back a summary of your most recent inbox
  messages.
- **"Search my email for the invoice"** — full-text searches your mailbox
  (same syntax as the Gmail search bar) and summarizes the top matches.
- **"Read me the email from Sarah"** — finds the best-matching message and
  reads its full body aloud.

JARVIS can also reach for `list_recent_emails`/`search_emails` on its own
mid-conversation (e.g. "did I hear back from the recruiter?") the same way
it already does for WolframAlpha and web search — see **Model Tiers**
above for which providers support this autonomous tool-calling today.

Without a connected Google account, all three commands respond with a
prompt to connect one in Settings rather than failing silently.

## Camera Vision
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Document Gmail integration and Google account setup in README"
```

---

## Task 12: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: PASS — every test file in `test/`, including all 6 new/modified files from this plan (`google-account-connector.test.js`, `gmail-harness.test.js`, `jarvis-core.gmail-routing.test.js`, `autonomous-tool-reasoner.gmail-detection.test.js`, updated `jarvis-tools.test.js`, updated `ai-intent-classifier.test.js`).

- [ ] **Step 2: Run the production build's secret scanner**

Run: `npm run build`
Expected: PASS — `vite build` succeeds and `scripts/check-dist-for-secrets.cjs` finds no leaked credentials (this catches any accidental hardcoded client secret/token, since none should exist — all Google credentials come from Settings/localStorage/main-process-only storage, never baked into the bundle).

- [ ] **Step 3: Manual Electron smoke test**

This exercises the parts no automated test can reach (Task 7/8/9/10's real OAuth flow and IPC round-trip). Requires a real Google Cloud OAuth client set up per the README's new "Google Account / Gmail" section.

1. Run `npm run dev` in one terminal, `npm run electron` in another.
2. Open **⚙️ SETTINGS**, paste a real Google Client ID/Secret, click **SAVE KEYS**.
3. Confirm a **"📧 Google Account"** section appears with a **CONNECT GOOGLE ACCOUNT** button.
4. Click it, approve access in the browser tab that opens, confirm it redirects to the "JARVIS: Google account connected." page and the Settings status flips to **"✅ Connected"**.
5. Say or type **"check my email"** — confirm JARVIS speaks a summary of recent messages, and the Terminal panel log shows `[GMAIL] Listed N recent message(s).`
6. Say or type **"search my email for <something you know exists>"** — confirm a relevant result comes back.
7. Say or type **"read me the email from <a known sender>"** — confirm JARVIS reads back the actual body.
8. Ask something conversational that implies email without an exact command phrase (e.g. "did I get anything from GitHub recently?") — confirm the active LLM calls `search_emails`/`list_recent_emails` on its own (visible in the Terminal panel as a `[TOOL CALL]` log line) and grounds its answer in the real result.
9. Click **DISCONNECT** in Settings, confirm the status returns to "Not connected" and **"check my email"** now prompts to connect the account again instead of erroring.

This step produces no commit — it's verification only. If anything fails, fix it in the relevant task above and re-commit there rather than adding a new fixup task.
