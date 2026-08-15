# Gmail Integration & Google Account Connector — Design

**Goal:** JARVIS can check, search, and read the user's Gmail on request — spoken commands and autonomous mid-conversation grounding — without ever holding a scope wider than it needs.

## Architecture

Two new pieces, following the existing Spotify OAuth integration's exact shape (`electron/main.cjs`'s Spotify block, `SpotifyHarness`):

- **`GoogleAccountConnector`** (new, `src/google-account-connector.js`) — generic, Gmail-agnostic OAuth wrapper. Methods: `authStatus()`, `login(clientId, clientSecret)`, `logout()`. Gmail is its first consumer; a future Calendar/Drive harness reuses this same connector without touching this file.
- **`GmailHarness`** (new, `src/gmail-harness.js`) — Gmail-specific read operations built on top of the connector's access token: `listRecent(maxResults = 10)`, `search(query, maxResults = 10)`, `getMessage(id)`. Same `{success, message}` return shape as every other harness; a not-connected account is never a dead end (returns a spoken prompt to connect in Settings).

## OAuth Flow

Mirrors the Spotify block in `electron/main.cjs` line-for-line where the protocols allow:

- New constants: `GOOGLE_REDIRECT_PORT` (43418, next free port after Spotify's 43417), `GOOGLE_REDIRECT_URI`, `GOOGLE_AUTH_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly openid email profile'`.
- Authorization Code flow + PKCE (`code_verifier`/`code_challenge`) — Google's Desktop-app OAuth clients receive a client secret but Google's own docs note it isn't a true secret for installed apps, so PKCE is the real protection layer here.
- `googleTokensPath()` / `loadGoogleTokens()` / `saveGoogleTokens()` / `clearGoogleTokens()` — `safeStorage`-encrypted token file at `userData/google-tokens.bin`, identical pattern to `spotify-tokens.bin`.
- `getValidGoogleAccessToken()` — refresh-on-expiry with a 60s safety margin, same as `getValidSpotifyAccessToken()`.
- `registerGoogleAuthIpc()`: `google:auth-status`, `google:logout`, `google:authorize` (opens system browser, catches the loopback redirect, exchanges the code — client secret and tokens never leave the main process), plus Gmail-specific handlers `gmail:list-messages`, `gmail:get-message`, `gmail:search-messages` that do the actual `https://gmail.googleapis.com/gmail/v1/...` calls using the current access token.
- `electron/preload.cjs` exposes `googleAuth: { status, login, logout }` and `gmail: { listMessages, getMessage, search }` via `contextBridge`, same shape as `spotifyAuth`/the Spotify library calls.

## Tool-Calling Hookup

Two paths, matching how every other capability in this codebase is exposed to the LLM:

1. **Explicit intents** — `GMAIL_CHECK_INBOX` (`{}`), `GMAIL_SEARCH` (`{query}`), `GMAIL_READ_MESSAGE` (`{query}`, fuzzy-matched against subject/sender since voice can't supply a message ID) added to:
   - `ai-intent-classifier.js`'s `TOOL_PARAM_REQUIREMENTS` and system prompt tool list.
   - `autonomous-tool-reasoner.js` regex fallbacks (e.g. `/check (my )?(email|gmail|inbox)/i`, `/(search|find) (my )?email.*for (.+)/i`, `/read (me )?(the )?(email|message) from (.+)/i`).
   - `jarvis-core.js`'s `processUserInput` dispatch switch, calling the corresponding `gmailHarness` method and speaking a formatted summary (sender + subject + snippet for a list; full body for a single read).
2. **Autonomous grounding tools** — `list_recent_emails` (`{}`) and `search_emails` (`{query}`) added to `jarvis-tools.js`'s `GROUNDING_TOOLS` array and `createToolExecutor`'s dispatcher, alongside `solve_math`/`web_search`. Read-only, so this fits the file's existing documented invariant that grounding tools never change state. Reachable by Groq/OpenRouter today via `fetchChatCompletion`'s `tools`/`toolExecutor` params.

**Known pre-existing gap, explicitly out of scope:** `GeminiClient.generateCompletion` doesn't accept a `tools` parameter at all, so on the Ultra tier neither the new Gmail tools nor the existing `solve_math`/`web_search` tools are reachable autonomously. Not fixed by this project.

## Settings UI

New "Google Account" section in the Settings modal (`index.html` + `main.js`'s `initGoogleAccountPanel()`), structurally identical to the existing Spotify Account section: `googleClientIdInput`/`googleClientSecretInput` password fields (`jarvis_google_client_id`/`jarvis_google_client_secret` in localStorage), `googleAccountStatus` text, `googleConnectBtn`/`googleDisconnectBtn`. Connect button calls `googleAccountConnector.login(clientId, clientSecret)` directly — same as Spotify, never from a voice/model-triggered path.

README gets a new "Google Account / Gmail" section: Google Cloud Console walkthrough (create project → enable Gmail API → configure OAuth consent screen, add self as test user → create OAuth 2.0 Client ID, Desktop app type → copy Client ID/Secret into JARVIS Settings), the exact scope requested, and what each voice command does.

## Data Flow

```
"Check my email"
  → JarvisCore.processUserInput
  → AI intent classifier / regex reasoner → {toolName: 'GMAIL_CHECK_INBOX'}
  → gmailHarness.listRecent()
  → window.jarvisElectron.gmail.listMessages()
  → preload → ipcMain 'gmail:list-messages'
  → getValidGoogleAccessToken() (refreshes if needed)
  → Gmail API GET
  → main process trims to {id, from, subject, snippet, date}[]
  → GmailHarness formats a spoken summary
  → same unified log/speak/response path every other harness uses
```

Mid-conversation ("did I hear back from the recruiter?") that doesn't match a `GMAIL_*` intent falls to `CONVERSATIONAL`, where `_chatWithActiveLLM` runs with `groundingTools` including `search_emails` — the active model (Groq/OpenRouter) can call it autonomously and ground its answer in real inbox data, one follow-up round, same as `web_search` today.

## Security

- Scope requested: `gmail.readonly` + `openid email profile` only. No send/modify/delete scope in this phase — a leaked token can't act on the mailbox, only read it.
- Client secret, access token, and refresh token never reach the renderer or localStorage — main process only, `safeStorage`-encrypted at rest.
- OAuth login only ever fires from an explicit Settings button click — never voice, never model-initiated, matching the existing Spotify invariant.
- Deliberately left open for a follow-up (not built now): `gmail.compose`/`gmail.send` scopes behind a separate, explicit re-consent, plus a mandatory "here's the draft, confirm before I send" step in `GmailHarness` before any send call.

## Error Handling

- Google account not connected: harness methods return `{success: false, message: "Your Google account isn't connected yet. Connect it in Settings, Sir."}` immediately, no network call — same shape as Spotify's not-connected fallback.
- Token refresh failure / Gmail API error: caught in the IPC handler, real error message surfaced (not a bare HTTP status — same discipline as the Gemini client fix from the previous session), harness catches it and returns a spoken apology instead of throwing.
- `search_emails`/`list_recent_emails` grounding-tool failures resolve to a "no result" string (never throw) so the calling model can still answer from its own knowledge — same pattern as `web_search` in `jarvis-tools.js`.

## Testing

`node:test` unit coverage, mirroring the Camera Vision harness's test suite from the previous session:

- `google-account-connector.test.js` — thin wrapper, mocked `window.jarvisElectron.googleAuth`.
- `gmail-harness.test.js` — mocked electron bridge; covers not-connected fallback, `listRecent`/`search`/`getMessage` success and API-error paths.
- `jarvis-core.gmail-routing.test.js` — dispatch tests for the 3 new intents, mirroring `jarvis-core.camera-vision-routing.test.js`.
- `autonomous-tool-reasoner.gmail-detection.test.js` — regex fallback coverage.
- `ai-intent-classifier` — extend existing tests for the new `TOOL_PARAM_REQUIREMENTS` entries.
- `jarvis-tools.test.js` — extend `createToolExecutor` coverage for `list_recent_emails`/`search_emails`.

`electron/main.cjs`'s OAuth/IPC handlers aren't unit-tested today (no test harness for `main.cjs` exists in this codebase) — verified manually instead: run `npm run electron`, connect the account via Settings, run each voice command, confirm the Terminal panel logs show the full IPC round-trip.
