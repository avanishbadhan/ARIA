# J.A.R.V.I.S. Voice AI

A desktop voice assistant with wake-word listening ("Jarvis" / "Hey Jarvis"),
OpenRouter/Groq-powered conversation, Google search automation, WolframAlpha-
grounded math, a Steam game launcher, a Spotify launcher, and self-updating
via GitHub Releases — built as an Electron app with a HUD-style web UI.

## Setup

    npm install

### API keys

JARVIS works with zero configuration (it falls back to a small local
knowledge base and your OS's built-in speech recognition), but for real
conversational answers you'll want at least one of OpenRouter or Groq —
either is enough on its own, Groq is just faster. There are two ways to
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
| `VITE_OPENROUTER_API_KEY` | One of OpenRouter or Groq — powers conversational answers | https://openrouter.ai/keys |
| `VITE_GROQ_API_KEY` | One of OpenRouter or Groq — much faster responses | https://console.groq.com/keys |
| `VITE_DEEPGRAM_API_KEY` | Optional — better speech recognition | https://console.deepgram.com |
| `VITE_WOLFRAM_APP_ID` | Optional — grounds math answers in a real computation instead of the LLM guessing | https://products.wolframalpha.com/api |
| `VITE_STEAM_API_KEY` + `VITE_STEAM_ID` | Optional — launch games from your real library by name | https://steamcommunity.com/dev/apikey and https://steamid.io |
| `VITE_SPOTIFY_CLIENT_ID` + `VITE_SPOTIFY_CLIENT_SECRET` | Optional — resolves the exact track so "play X on Spotify" auto-plays instead of just opening a search | https://developer.spotify.com/dashboard |

Steam credentials have their own setup box in the left panel of the app —
same idea, paste and save, no `.env` required.

## Settings

Click **⚙️ SETTINGS** in the header to configure:

- **Open browser tab when searching Google** — Y/N. When off, search
  results still appear in the in-app HUD viewport, just without also
  popping a new browser tab.
- **Voice gender** — Male / Female. Picks a matching system/browser TTS
  voice by name (the Web Speech API doesn't expose a real gender field, so
  this is a best-effort match against common voice names).
- **Voice output meter** — Y/N. Shows a small bar meter near the arc
  reactor that reacts while JARVIS is speaking. It approximates loudness
  from speech cadence (word boundaries), not a literal decibel reading —
  browsers don't expose an audio stream for built-in text-to-speech.
- **API Keys** — OpenRouter, Groq, Deepgram, WolframAlpha, and Spotify, as
  described above. OpenRouter, Groq, WolframAlpha, and Spotify key changes
  apply immediately; a newly added Deepgram key requires restarting JARVIS to
  take effect. Without a WolframAlpha key, math questions ("what is 5 plus 3",
  "square root of 144") are answered by whichever LLM is active instead —
  still works, just not guaranteed to be arithmetically correct. Without a
  Spotify Client ID/Secret (or when running outside the packaged Electron
  app), "play X on Spotify" opens the Spotify app pre-searched for X instead
  of auto-playing the exact track.
- **Use Groq instead of OpenRouter** — Y/N. Groq's `llama-3.1-8b-instant` is
  much faster than OpenRouter's free model pool. This is only needed to
  *prefer* Groq when you have both keys set — if you only set a Groq key and
  no OpenRouter key, JARVIS already uses Groq automatically regardless of
  this switch. Either way, if Groq fails (rate-limited, network error),
  JARVIS falls back to OpenRouter (if configured), then to the local
  knowledge base — same as always.
- **Software Update** (packaged app only, not `npm run dev`) — shows the
  installed version and checks GitHub Releases for newer ones. Major
  version bumps (`1.x` → `2.0.0`) download automatically in the background
  and just need a click on **Restart & Install** when ready. Minor/patch
  bumps (`1.0.0` → `1.1.0`) show a passive **Download Update** button
  instead — nothing downloads until you click it. Either way, installing
  always requires the explicit restart click; nothing installs itself
  without your say-so.

## Model Tiers

A **🧠 slider in the header** (not Settings) picks how JARVIS thinks, mapped
to different Groq models:

| Tier | Model |
|---|---|
| Quick | `llama-3.1-8b-instant` — fastest, default |
| Medium | `llama-3.3-70b-versatile` |
| High | `openai/gpt-oss-120b` — Groq's largest standalone reasoning model |
| Ultra | `groq/compound` — an agentic system that can autonomously do its own web search/code execution mid-answer |

Drag the slider, or just say **"switch mode to quick/medium/high/ultra"**
(also understands "low" for quick and "max"/"maximum" for ultra) — both
paths do the same thing and stay in sync with each other. Needs a Groq API
key (Settings, one-time); the slider stays disabled with a hint until one's
saved, and picking a tier automatically makes Groq the active provider.

## Spotify

Say **"open Spotify"** to launch the desktop app, or **"play &lt;song&gt; on
Spotify"** (also understands "spotify play &lt;song&gt;" and "play &lt;song&gt;
via spotify") to play a specific track. The word "spotify" has to be in the
phrase — bare "play &lt;title&gt;" still launches Steam games, exactly as
before.

- **Without a Spotify Client ID/Secret**, or when running as a plain browser
  tab instead of the packaged Electron app: opens Spotify pre-searched for
  the song — you click play yourself.
- **With a Spotify Client ID/Secret** (Settings, free at
  [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)),
  running inside Electron: JARVIS resolves the exact track via Spotify's
  Search API and plays it immediately, no click needed.

Either way, if the exact track can't be resolved (typo, obscure title, no
credentials, API error), JARVIS always falls back to opening Spotify search
rather than failing silently.

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

## Releasing an update

`npm run electron:build` only builds locally — it doesn't publish anything,
so existing installs won't see it as an update. To cut a real release that
the in-app updater will pick up:

1. Bump `"version"` in `package.json` (e.g. `1.0.0` → `1.1.0`). This is
   what the updater compares against — skipping it means the release won't
   be recognized as newer.
2. Generate a GitHub Personal Access Token with `repo` scope (or a
   fine-grained token scoped to this repo with "Contents: Read and write")
   at https://github.com/settings/tokens.
3. Set it as an environment variable and run the release script:

       $env:GH_TOKEN = "ghp_..."     # PowerShell, current session only
       npm run electron:release

   This builds the installer and publishes it as a live (non-draft) GitHub
   Release automatically — the `"releaseType": "release"` setting in
   `package.json`'s `build.publish` block is what makes this happen;
   `electron-builder` creates **draft** releases by default otherwise, and a draft is
   completely invisible to both the in-app updater and anyone visiting the
   repo's Releases page. If a release ever does end up stuck as a draft
   (e.g. from a build run before that setting was added), publish it
   manually from github.com/&lt;owner&gt;/&lt;repo&gt;/releases — no rebuild needed.

## Tests

    npm test

Runs the `node --test` suite in `test/` — headless, no API keys or running
app required.
