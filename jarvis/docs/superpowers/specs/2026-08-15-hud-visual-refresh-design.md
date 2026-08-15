# HUD Visual Refresh & Location Panel — Design

**Goal:** Adopt three specific visual/functional elements the user liked from a friend's standalone prototype (`gemini-code-1786406872387.html`, added to the repo root by a collaborator) into the real JARVIS Electron app: a pink accent color, darker/glassier panels, and a real location map panel. This is a targeted reskin plus one small new feature, not a wholesale redesign — the friend's triple-ring reactor animation and raw-Consolas font were explicitly not selected and are out of scope.

**Source of comparison:** Both files already share a cyan/dark HUD aesthetic. The friend's file additionally uses a pink accent (`--thinking-glow: #ff007f`), a darker/more opaque panel background (`--panel-bg: rgba(3, 14, 28, 0.85)` vs. the app's current `--bg-card: rgba(10, 20, 40, 0.65)`), and a Leaflet-based radar/map panel with a user-position marker.

---

## Section 1: Visual reskin (CSS only)

**Files:** `jarvis/src/styles.css`, `jarvis/src/main.js`

- Add `--accent-pink: #ff007f` to `:root`.
- Change `--bg-card` from `rgba(10, 20, 40, 0.65)` to `rgba(3, 14, 28, 0.85)` (darker/more opaque, matching the friend's panel background). Add a subtle inset glow to `.panel` (`box-shadow` gets an additional `inset 0 0 24px rgba(0, 243, 255, 0.05)` alongside the existing drop shadow).
- Add a `.status-dot.thinking` class (`background: var(--accent-pink); box-shadow: 0 0 12px var(--accent-pink); animation: pulse-fast 0.8s infinite ease-in-out;`) — this fills a real gap: `jarvis-core.js` already emits a `THINKING` status (`onStatusChange({ status: "THINKING", ... })`), but `main.js`'s status-dot logic only special-cases `SPEAKING` and `LISTENING`, so `THINKING` currently renders as plain cyan. Add `if (status === 'THINKING') statusDot.classList.add('thinking');` alongside the existing `SPEAKING`/`LISTENING` branches in `main.js`. This mirrors the friend's file, which already splits listening=gold/thinking=pink semantically.
- No other files change in this section.

## Section 2: Location harness + map panel

**Files:** Create `jarvis/src/location-harness.js`, `jarvis/test/location-harness.test.js`. Modify `jarvis/index.html`, `jarvis/src/main.js`, `jarvis/src/styles.css`, `jarvis/electron/main.cjs`, `jarvis/package.json` (new dependency).

**Scope decision (confirmed with user):** the map shows only the user's current position — no destination/target, no route info, no continuous tracking. JARVIS has no navigation/destination feature today, so porting the friend's target-info/route-info sidebar would be dead UI.

- **`LocationHarness`** (`src/location-harness.js`): wraps `navigator.geolocation.getCurrentPosition()` in a promise. Public method: `getCurrentPosition()` → `{ success: true, lat, lon }` on success, or `{ success: false, message }` on denial/timeout/unsupported (message follows the existing harness tone, e.g. `"I wasn't able to get your location, Sir."`). Unlike `GmailHarness`/`GoogleCalendarHarness`/`SpotifyHarness`, this harness has no `_isElectron()` branch and no Electron IPC bridge — `navigator.geolocation` is a standard Chromium renderer API available identically in dev-browser mode (`localhost:3000`) and the packaged Electron app, so there's nothing for `preload.cjs` to bridge.
- **Leaflet dependency:** add `leaflet` to `jarvis/package.json`. Import its JS + CSS in `main.js`/`index.html` the same way other third-party UI pieces are pulled in.
- **Panel markup** (`index.html`): new card in the left column, directly after the existing "📷 Camera Vision Harness" card, matching its structure — `panel-header` with title "🛰️ Location", a map container `<div id="locationMap">`, and a status line element (`id="locationStatus"`) reusing the same styling pattern as `steamLibraryStatus`.
- **Wiring** (`main.js`, inside `initApp()`): on load, call `locationHarness.getCurrentPosition()` once (not `watchPosition` — one-shot only). On success, initialize a Leaflet map (`L.map('locationMap').setView([lat, lon], 13)`, OSM tile layer, single marker at the coords). On failure, leave the map container empty and set `locationStatus.textContent` to the harness's message — same graceful-degradation pattern as the Steam/Spotify "not connected" states.
- **Electron main process** (`electron/main.cjs`): add a `session.defaultSession.setPermissionRequestHandler` that auto-approves `'geolocation'` requests. By default, Electron silently denies permission requests with no handler registered (no native OS prompt appears, `getCurrentPosition` just errors) — this is a genuine gotcha, not obvious from the renderer side, and will be documented in `AGENTS.md`'s Gotchas section alongside the existing Windows/WSL note.

## Section 3: Error handling & testing

- No permission granted, geolocation unsupported (shouldn't happen in Chromium/Electron but defensively handled), or timeout → `LocationHarness.getCurrentPosition()` resolves (never rejects) with `{ success: false, message }`. The panel shows the message text in place of the map. No exceptions propagate to `main.js`.
- **Testing:** `test/location-harness.test.js` mocks `global.navigator.geolocation` (stubbed `getCurrentPosition` that either calls the success callback with fake coords or the error callback with a fake `GeolocationPositionError`), following the existing harness test pattern (see `test/gmail-harness.test.js` for the shape). Covers: success returns `{success:true, lat, lon}`; permission-denied, timeout, and position-unavailable errors each return a distinct graceful message; unsupported (`navigator.geolocation` undefined) returns a graceful message without throwing.
- Leaflet's actual map rendering (tile loading, DOM canvas) is not unit-testable under `node --test` — same category as `voice-engine.js` and `electron/main.cjs`, verified manually per the project's existing convention.
- `jarvis-core.js`'s intent pipeline (`ai-intent-classifier.js`, `autonomous-tool-reasoner.js`, `TOOL_PARAM_REQUIREMENTS`) is untouched — the location panel is passive UI populated on load, not a voice/text-triggered action, so it doesn't need an intent, a grounding tool, or a dispatch block.

## Out of Scope

- Triple-ring reactor animation (not selected by user — existing 2-ring reactor stays as-is).
- Raw-Consolas monospace font (not selected — app keeps its existing Outfit/Roboto Mono pairing).
- Target/destination marker, route info, "widget dock" clock widget from the friend's file (not requested; no backing feature exists for them yet).
- Continuous location tracking (`watchPosition`) — one-shot only, per the scope decision above.
- Any change to voice/text command handling, grounding tools, or the intent classifier.
