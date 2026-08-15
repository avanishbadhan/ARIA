# Settings Panel & First-Run Readiness — Design

## Goal
Give JARVIS a Settings panel covering the four requested preferences, and make the
project runnable by someone other than the original author without reading source
code first.

## Settings covered

| Setting | Control | Default | Storage |
|---|---|---|---|
| Open browser tab when Google-searching | Y/N toggle | `true` (matches current hardcoded behavior) | `jarvis_settings.openTabOnSearch` |
| Voice gender | Male / Female radio | `male` (matches current hardcoded voice pick) | `jarvis_settings.voiceGender` |
| Voice output meter visibility | Y/N toggle | `true` | `jarvis_settings.soundMeterEnabled` |
| OpenRouter API key | password input | — | `jarvis_openrouter_api_key` (existing key name) |
| Deepgram API key | password input | — | `jarvis_deepgram_api_key` (existing key name) |

Steam credentials keep their existing dedicated panel — not duplicated here.

## New module: `src/settings.js`
Plain functions, no class needed (this is pure data, not behavior):
- `DEFAULT_SETTINGS` — the defaults table above.
- `loadSettings()` — reads `jarvis_settings` from localStorage, merges over
  defaults (so old/missing keys don't break new installs), returns a plain object.
- `saveSettings(partial)` — merges `partial` over the current stored settings and
  writes back.

Read ad hoc (`loadSettings()` at the point of use) rather than injected through
constructors, matching how the codebase already reads `localStorage` directly —
avoids prop-drilling a settings object through `JarvisCore`/`VoiceEngine`.

## Wiring

**`jarvis-core.js`** — Google search branch currently hardcodes
`this.harness.executeGoogleSearch(decision.params.query, true)`. Change the `true`
to `loadSettings().openTabOnSearch`. `executeGoogleSearch` already accepts this
parameter; no other change needed there.

**`voice-engine.js`** — `_initSpeechSynthesis()` currently picks a voice with a
male-leaning name heuristic. Add a female-name heuristic list and branch on
`loadSettings().voiceGender`. Expose the method as callable post-construction
(rename to public `applyVoicePreference()`, called from the constructor and again
after Settings save) so a gender change takes effect immediately, no reload.

**Voice output meter** — new small UI element (a row of bar segments) near the
arc reactor. Since `speechSynthesis` exposes no audio stream/volume data (browser
limitation — there is no `MediaStream` to feed an `AnalyserNode`), it cannot be a
literal decibel meter. Instead: `VoiceEngine.speak()` attaches an
`utterance.onboundary` handler; on each word boundary it invokes a new
`onSpeechMeter({ active: true, intensity })` callback, where `intensity` is
derived from the boundary's `charLength` (falls back to a fixed pulse if the
browser doesn't report `charLength`). `main.js` uses this to animate bar heights
with a short decay via `requestAnimationFrame`, resetting to flat on `onend`. The
whole row is hidden via a CSS class when `soundMeterEnabled` is `false`. This is a
speech-cadence-driven approximation, not a real loudness measurement — documented
in a code comment so it isn't mistaken for one later.

**API keys** — `OpenRouterClient.apiKey` and `VoiceEngine.deepgramApiKey` are
plain instance fields. Settings panel writes directly to their localStorage keys
and then:
- OpenRouter: sets `jarvis.openRouter.apiKey = value` directly — takes effect on
  the very next request, no reload.
- Deepgram: `VoiceEngine.engine` (`'deepgram' | 'electron' | 'browser'`) is
  chosen once in the constructor based on whether a key was present at startup.
  Saving a Deepgram key after launch cannot hot-swap the active STT engine
  without a nontrivial teardown/rebuild of listening state, which is out of
  scope here. The panel shows a note: "Restart JARVIS to activate Deepgram
  speech recognition" — an explicit, honest limitation rather than a silent
  no-op.

## UI
A ⚙️ button in the header (next to the existing mute button) opens a modal
styled after the existing `.steam-setup-box` (same HUD look: dark panel, cyan/gold
borders, monospace labels). Sections in order: General, Voice, Voice Output
Meter, API Keys. A "Saved ✓" inline confirmation replaces the need for a
separate success screen. Closing the modal (X button, backdrop click, or Esc)
does not discard anything — every control saves on change/blur, matching the
existing Steam panel's save-on-click pattern adapted to instant-apply toggles.

## Ready-to-use polish
- **`README.md`** — what JARVIS is, `npm install`, how to get each API key
  (OpenRouter, Deepgram, Steam) and where to put it (`.env` for a baked-in build,
  or the in-app Settings panel for a runtime-configurable one), `npm run dev` +
  `npm run electron` for local dev, `npm run electron:build` for a packaged
  installer, and `npm test`.
- **`.env.example`** — `VITE_OPENROUTER_API_KEY`, `VITE_DEEPGRAM_API_KEY`,
  `VITE_STEAM_API_KEY`, `VITE_STEAM_ID`, each with a one-line comment on what it
  does and whether it's required. `.env` itself stays gitignored (already is).

## Testing
Extend the existing `node --test` suite (see `test/jarvis-core.conversation-memory.test.js`
for the established shimming pattern):
- `test/settings.test.js` — defaults, save/load round-trip, partial-merge
  behavior, missing/corrupt localStorage value falls back to defaults.
- Extend the `jarvis-core` test file (or add a new one) to confirm the Google
  search branch passes `loadSettings().openTabOnSearch` through to
  `harness.executeGoogleSearch`.

## Out of scope
- Real audio-level metering (no browser API surface for it with native TTS).
- Hot-swapping the STT engine when a Deepgram key is added post-launch.
- Any change to the existing Steam credentials panel.
