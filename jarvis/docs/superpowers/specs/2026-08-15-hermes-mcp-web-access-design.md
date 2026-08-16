# Hermes Provider & MCP Web Access — Design

**Goal:** Add Hermes (Nous Research, via OpenRouter) as a selectable LLM provider, and give JARVIS real web-browsing capability — reading actual webpage content instead of the current thin DuckDuckGo/Wikipedia instant-answer lookup — via a single curated MCP server. These are two separable pieces that happen to be requested together: Hermes needs no new infrastructure (mirrors the existing `useGroq` provider-toggle pattern), while the MCP web-access work is genuinely new architecture and is provider-agnostic — every LLM provider benefits from it, not just Hermes.

---

## Section 1: Hermes provider

**Files:** `jarvis/src/settings.js`, `jarvis/src/jarvis-core.js`, `jarvis/index.html`, `jarvis/src/main.js`

- New `useHermes: false` entry in `DEFAULT_SETTINGS`, surfaced as a Settings toggle next to the existing "Use Groq" one.
- Hermes is OpenRouter-hosted, so it needs no new API key — it reuses `jarvis_openrouter_api_key`. Implementation is a thin wrapper reusing `OpenRouterClient`'s transport/headers/API key with a different, fixed model queue pinned to a Hermes model (exact OpenRouter model slug — e.g. a `nousresearch/hermes-...` variant — to be confirmed against OpenRouter's live catalog during implementation, since slugs can change).
- `_chatWithActiveLLM()` gains a Hermes branch ahead of the existing Groq check: if `useHermes` is on, try Hermes first; on failure (`null` return, same convention as every other provider), fall through to Groq→OpenRouter→local-knowledge-base exactly as today. `useHermes` and `useGroq` are independent toggles — if both are somehow on, Hermes is tried first since it's the more capable/agentic model for tool-calling.

## Section 2: MCP/Playwright architecture

**Files:** `jarvis/electron/main.cjs`, `jarvis/electron/preload.cjs`, create `jarvis/src/mcp-web-harness.js`

- **Server choice:** `@playwright/mcp` (Microsoft's official Playwright MCP server) is the single curated MCP server for this feature. It's Node-based, so it stays inside the existing npm/Electron toolchain — no second runtime (the official reference "fetch" MCP server is Python/`uvx`-based, which would mean managing two different process runtimes; given this repo already documents real Windows-native-binary pain in `AGENTS.md`, a Python dependency isn't worth adding on top of that for this feature).
- `main.cjs` spawns `@playwright/mcp` as a child process using the MCP SDK's `StdioClientTransport` + `Client`, on first use (not at app startup — avoids the overhead/failure surface on every launch when nobody's asked JARVIS anything web-related yet). The client instance is cached and reused across calls; if the process dies, the next call respawns it.
- Two new `ipcMain.handle` endpoints, mirroring the existing IPC-handler pattern used for Gmail/Calendar/Spotify:
  - `mcp:fetch-webpage(url)` — navigates to the URL, extracts readable page text (truncated similarly to how `fetchGmailFullMessage` truncates long email bodies, so a huge page doesn't blow the LLM's context).
  - `mcp:browse-webpage(url, linkText)` — navigates to the URL, optionally clicks/follows a link matching `linkText`, extracts the resulting page's readable text. This is the *only* interactive capability exposed — no arbitrary click/type/form-submit surface.
- `preload.cjs` bridges both as `window.jarvisElectron.mcp.fetchWebpage(url)` / `.browseWebpage(url, linkText)`.
- **New `src/mcp-web-harness.js` (`McpWebHarness`)**, same shape as every other harness: `_isElectron()` check (mirrors `GmailHarness`/`GoogleCalendarHarness`), returns a graceful "not available in dev-browser mode" result when running at `localhost:3000` outside Electron (Playwright automation only runs through the Electron main process, unlike the Location panel's plain-browser Geolocation API). Two methods: `fetchWebpage(url)` and `browseWebpage(url, linkText)`, each returning `{ success, text, message }` or `{ success: false, message }` on failure — same result shape as every other harness.
- **Trust-boundary constraint (carried over from the existing grounding-tools philosophy):** only navigate+extract-text is ever exposed to the autonomous LLM tool-calling loop. Playwright MCP's full action surface (arbitrary clicking, typing, form submission, file downloads) is never wired up — `browse_webpage`'s "follow a link" is a single constrained navigation step, not general browser control. This keeps web access read-only, consistent with `jarvis-tools.js`'s existing rule that state-changing actions never reach autonomous tool-calling.

## Section 3: Grounding tools

**Files:** `jarvis/src/jarvis-tools.js`, `jarvis/src/jarvis-core.js` (wiring `McpWebHarness` into `createToolExecutor`)

- `web_search`'s tool name, description, and parameters (`{ query }`) stay unchanged, but its executor implementation is replaced: instead of calling `harness.fetchLiveSearchAnswer()` (DuckDuckGo/Wikipedia), it builds a Google search URL from the query and calls `mcpWebHarness.fetchWebpage(googleSearchUrl)`, returning the extracted result text. Nothing else in the codebase needs to change — the tool's contract (name, params, "returns a string") is identical, only what's behind it improves.
- New `browse_webpage` tool: `{ url: string, linkText?: string }` → calls `mcpWebHarness.browseWebpage(url, linkText)`. Used when the model already has a specific URL to read (e.g., a link surfaced in a prior `web_search` result, or a URL the user mentioned directly).
- Both tools available to any active provider (Hermes, Groq, OpenRouter, Gemini) — `GROUNDING_TOOLS`/`createToolExecutor` are already provider-agnostic (per the existing header comment in `jarvis-tools.js`), so no gating logic is added.
- `createToolExecutor`'s signature gains an `mcpWeb` parameter (the `McpWebHarness` instance), following the same pattern `gmail`/`calendar` already use.

## Section 4: Error handling, setup, and testing

- **Setup gotcha:** Playwright needs its browser binaries downloaded once via `npx playwright install` — this will be documented in `AGENTS.md`'s Gotchas section next to the existing Windows/WSL native-binary note, since it's the same category of "silent failure if skipped" trap.
- **Failure modes** (MCP server fails to spawn, times out, page fails to load, navigation error): `McpWebHarness` methods never throw — they resolve to `{ success: false, message }`, and `web_search`/`browse_webpage`'s executors fall back to the existing `NO_SEARCH_RESULT`-style sentinel string, so a web-access failure degrades to "no result" rather than breaking the LLM's turn. Same convention as every other tool in `jarvis-tools.js`.
- **Testing:** `test/mcp-web-harness.test.js` unit-tests `McpWebHarness`'s pure logic (Google search URL construction, response formatting, the dev-browser-mode fallback) against a mocked `window.jarvisElectron.mcp`, following the existing harness test pattern (see `test/gmail-harness.test.js`). Actual MCP process spawning and Playwright browser automation are not unit-testable under `node --test` — same category as `electron/main.cjs` and `voice-engine.js` — verified manually.
- `test/jarvis-tools.test.js`'s exact-tool-name-list assertion (`GROUNDING_TOOLS.map(t => t.function.name)`) needs updating to include `browse_webpage`, plus new delegation tests for both `web_search`'s new implementation and `browse_webpage`, mirroring the existing Gmail/Calendar tool tests in that file.

## Out of Scope

- General/open MCP server configuration (connecting arbitrary user-specified MCP servers) — explicitly rejected in favor of one curated, audited server.
- A second lightweight fetch-only MCP server alongside Playwright — explicitly rejected; Playwright alone covers both simple fetches and interactive browsing.
- Exposing Playwright's full browser-automation surface (clicking, typing, form submission, downloads) to autonomous tool-calling — only navigate+extract-text and single constrained link-following are exposed.
- Gating the new web tools to only-when-Hermes-is-active — they're provider-agnostic, available to any LLM provider.
- A dedicated Hermes API key/client — Hermes is accessed via the existing OpenRouter connection.
