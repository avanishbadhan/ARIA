# AGENTS.md

This repo is a Windows-first desktop app. You may be coding in WSL — that matters for one critical gotcha below.

## The real app lives in `jarvis/`

The actively-developed product is `jarvis/` (Electron + Vite + renderer, J.A.R.V.I.S.). The root `package.json` is a thin delegator (`npm --prefix jarvis run ...`). Root `src/index.js` and `public/` are legacy/separate (a bare Node "start" stub and a Gemini-browser HUD); do not touch them for jarvis work.

## Windows / WSL platform gotcha (highest priority)

Native optional dependencies are platform-specific (Rollup's `@rollup/rollup-win32-x64-msvc`, esbuild, etc.). **Running `npm install` inside WSL/Linux prunes the Windows binaries from `node_modules` and breaks `npm run dev`/`npm run electron` on the Windows side** (observed: rollup error after a WSL install). Any install/rebuild must run from Windows PowerShell. If `node_modules` is already platform-mixed, fix from PowerShell:

```
cd jarvis
rm -r node_modules; rm package-lock.json   # restore lock first via git if it was modified
npm install
```

Note: pure-JS test runs (`node --test`) are platform-agnostic and work from WSL.

## Commands

Run from repo root (or `jarvis/` directly):

- `npm run dev` — Vite dev server on `:3000` (delegates to jarvis).
- `npm run electron` — Electron window pointing at the dev server; needs `npm run dev` running first (two terminals).
- `npm --prefix jarvis test` — full `node --test` suite; headless, no API keys required. Must pass with zero regressions before finishing work.
- Single test file: `node --test test/<file>.test.js` from `jarvis/`.
- `node --check electron/main.cjs` — the Electron main process has no test coverage; syntax-check is the only verification for `main.cjs`/`preload.cjs` changes.
- `npm --prefix jarvis run electron:build` — `vite build` + `scripts/check-dist-for-secrets.cjs` (secrets scan runs on every build).

## Architecture (renderer ↔ main boundary)

- `electron/main.cjs` owns all OAuth (Google, Spotify) and every external API call (Gmail, Calendar, Spotify, Steam, Wolfram) as IPC handlers. Renderer never touches credentials or makes CORS-prone calls directly.
- Renderer "harnesses" (`src/*-harness.js`) call through the preload bridge `window.jarvisElectron.*` (`electron/preload.cjs`). Harnesses hold NO credentials — `clientId`/`clientSecret` are passed into every call (mirror `gmail-harness.js` / `spotify-harness.js`).
- Intent pipeline: `ai-intent-classifier.js` (AI-first, validated) → `autonomous-tool-reasoner.js` (regex fallback) → dispatch blocks in `jarvis-core.js`. A new intent must be wired into all three plus the `TOOL_PARAM_REQUIREMENTS` map.
- Read-only "grounding tools" live in `jarvis-tools.js` (`GROUNDING_TOOLS` + `createToolExecutor`). State-changing actions (Gmail send, event creation, playback control) are deliberately excluded from grounding tools and only reachable via explicit intent dispatch.
- Design specs are the authoritative source for new features: `jarvis/docs/superpowers/specs/` (read the spec before implementing, e.g. the Google Calendar harness spec).
- A knowledge graph of this codebase (code + docs, with community clusters and cross-references) lives in `graphify-out/` (gitignored, regenerate with `/graphify`). Check `graphify-out/GRAPH_REPORT.md` or `graphify-out/graph.html` before a large refactor to see how a module connects to the rest of the app; open `graphify-out/obsidian/` as an Obsidian vault for interactive browsing (graph view + `graph.canvas` community layout).

## Testing conventions

Mirror the existing per-feature test-file pattern exactly:

- `test/<harness>-harness.test.js` (mock `window.jarvisElectron.*`)
- `test/jarvis-core.<feature>-routing.test.js` (routing + constructor wiring, via `test/helpers/jarvis-test-utils.js`)
- `test/autonomous-tool-reasoner.<feature>-detection.test.js` (regex detection)
- Extend `test/ai-intent-classifier.test.js` and `test/jarvis-tools.test.js` with accept/reject + delegation cases.

## Gotchas

- `jarvis/vite.config.js` uses `base: './'` — required for the packaged `file://` build; don't revert it. Dev proxies for `/steam-api` and `/wolfram-api` exist.
- Google OAuth scope in `main.cjs` now includes `calendar.events` (incremental). Accounts connected before that change need a one-time disconnect/reconnect — a stale token authenticates but Calendar calls 403. New scope additions carry the same consequence.
- `.env*`, `dist/`, `release/` are gitignored; never commit real credentials.
- The Location panel needs `navigator.geolocation`, which Electron **silently denies** by default when no `setPermissionRequestHandler` is registered (no native OS prompt appears — `getCurrentPosition` just errors). `main.cjs` auto-approves `'geolocation'` (alongside `'media'`); if you remove or replace that handler, the Location map will break without any visible error.
- The `web_search`/`browse_webpage` grounding tools need Playwright's browser binary downloaded once: `npx playwright install chromium` (from `jarvis/`, after `npm install`). Without it, `electron/mcp-manager.cjs`'s spawned `@playwright/mcp` process fails on first navigation and both tools degrade to their "unable to read" fallback message — no crash, but silently useless until the binary is installed.
- Hermes (`useHermes` setting) is **not** part of the free-model pool like everything else in this app — it's a real paid OpenRouter model (`nousresearch/hermes-4-405b`). It reuses the existing OpenRouter API key (no new key to configure), but toggling it on spends OpenRouter credits on every request.

## Git conventions (from both `CLAUDE.md` files — preserve)

Commit only as **Taksh Biyani <taksh.r.biyani@gmail.com>**. Do not add `Co-Authored-By` or any Claude/assistant session reference to commit messages.
