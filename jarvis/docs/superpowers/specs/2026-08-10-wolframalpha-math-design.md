# WolframAlpha Math Integration — Design

**Goal:** Math questions get an accurate WolframAlpha-computed answer instead of relying on the LLM's own (sometimes wrong) arithmetic.

## API Choice

**Spoken Results API** (`https://api.wolframalpha.com/v1/spoken?appid=...&i=...`) — purpose-built for voice assistants. Returns one natural-language sentence ready to speak directly (e.g. "The result is 42"), no response formatting needed on our end. Free tier included with a standard AppID from products.wolframalpha.com/api.

Rejected alternatives: the Short Answers API returns a bare value with no sentence wrapper (would need hand-crafted phrasing); the Full Results API is paid-only and returns rich structured "pods" — far more than a spoken one-liner needs.

## Architecture

- **`src/wolfram-client.js`** — new client class, same shape as `GroqClient`/`OpenRouterClient`: constructor takes an AppID + `{ onLog }`, one method `async solve(query)` returning the spoken sentence string, or `null` on no key / API error / no result found (`didyoumean`/no answer cases).
- **CORS routing** — mirrors the existing Steam integration's 3-tier pattern (`src/steam-library.js`):
  - Inside Electron: new `wolfram:solve` `ipcMain.handle` in `electron/main.cjs` (plain Node HTTPS request, no CORS), bridged via `window.jarvisElectron.solveMath(appId, query)` in `electron/preload.cjs`.
  - Plain browser dev mode: new `/wolfram-api` proxy entry in `vite.config.js` pointing at `api.wolframalpha.com`.
  - Static/non-proxied browser fallback: same public CORS proxy (`api.allorigins.win`) already used for Steam, for consistency.
- **Detection** — new `MATH_QUERY` branch in `autonomous-tool-reasoner.js`'s `evaluateIntent`, checked before the existing search/conversational fallback (but after Steam gaming keywords, so "play 2048" etc. still resolves as a game). Heuristic:
  - Arithmetic/math symbols: `+ - × ÷ √ ^ % =` (with care not to false-positive on things like "c++" — symbol check requires digits nearby)
  - Digit-heavy expressions (e.g. `"12 * 8"`, `"45% of 200"`)
  - Keyword phrases: `calculate`, `solve`, `what is ... plus/minus/times/divided by/to the power of ...`, `square root of`, `derivative of`, `integral of`, `percent of`, `factorial of`, `log of`
  - Scoped to arithmetic through high-level math (algebra, calculus, percentages) per your confirmation — not a catch-all for general trivia.
- **Routing in `jarvis-core.js`** — new branch alongside `GOOGLE_SEARCH`/`STEAM_LAUNCH_GAME`:
  1. Call `wolfram.solve(query)`.
  2. If it returns a real answer: speak it directly — no LLM round-trip, since the spoken sentence is already complete and correct. This also means the LLM can't second-guess or "correct" a right answer into a wrong one.
  3. If WolframAlpha has no key configured, errors, or returns no result: fall through to the existing `_chatWithActiveLLM` conversational path, exactly like every other fallback already in this app (Groq→OpenRouter→local KB, Steam library→dict→store search).
- **Settings** — new "WolframAlpha AppID" password-style input in the API Keys section of the Settings modal, optional, with a "get one free at products.wolframalpha.com/api" hint — same UX/localStorage pattern as the Deepgram key (`jarvis_wolfram_app_id`).

## Error Handling

- No AppID configured: `solve()` returns `null` immediately (no network call) — same as Groq/OpenRouter with no key.
- Network/API error: caught, logged via `onLog` with `logPrefix: 'WOLFRAM'`, returns `null` — falls through to LLM chat, doesn't break the conversation.
- WolframAlpha returns HTTP 501 (its documented "no spoken result available" response for that query): treated as `null` — same fallthrough.

## Testing

`wolfram-client.js`'s `solve()` hits a real network endpoint, so like the LLM clients it isn't fully unit-tested for the live API call itself — but the routing decision logic is: a new `test/jarvis-core.math-routing.test.js` (mirroring the existing `jarvis-core.search-grounding.test.js` pattern) verifies that a math query calls `wolfram.solve()` and speaks its result directly without invoking the LLM, and that a `null` result from `wolfram.solve()` falls through to the LLM path. The detection heuristic itself (`MATH_QUERY` classification in `autonomous-tool-reasoner.js`) gets direct unit coverage for a range of math and non-math phrasings, similar to how gaming-keyword detection is implicitly covered today.
