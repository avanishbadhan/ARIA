# J.A.R.V.I.S. Voice AI

A desktop voice assistant with wake-word listening ("Jarvis" / "Hey Jarvis"),
OpenRouter/Groq-powered conversation, Google search automation, WolframAlpha-
grounded math, a Steam game launcher, a Spotify launcher, read-only Gmail
access, and self-updating via GitHub Releases — built as an Electron app
with a HUD-style web UI.

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
| `VITE_GEMINI_API_KEY` | Required for the Ultra model tier (see Model Tiers below) | https://aistudio.google.com/apikey |
| `VITE_DEEPGRAM_API_KEY` | Optional — better speech recognition | https://console.deepgram.com |
| `VITE_WOLFRAM_APP_ID` | Optional — grounds math answers in a real computation instead of the LLM guessing | https://products.wolframalpha.com/api |
| `VITE_STEAM_API_KEY` + `VITE_STEAM_ID` | Optional — launch games from your real library by name | https://steamcommunity.com/dev/apikey and https://steamid.io |
| `VITE_SPOTIFY_CLIENT_ID` + `VITE_SPOTIFY_CLIENT_SECRET` | Optional — resolves the exact track so "play X on Spotify" auto-plays instead of just opening a search | https://developer.spotify.com/dashboard |
| `VITE_GOOGLE_CLIENT_ID` + `VITE_GOOGLE_CLIENT_SECRET` | Optional — lets JARVIS check/search/read your Gmail (read-only) | https://console.cloud.google.com/apis/credentials |

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

A **🧠 slider in the header** (not Settings) picks how JARVIS thinks. Quick,
Medium, and High run on Groq; Ultra runs on Gemini:

| Tier | Provider | Model |
|---|---|---|
| Quick | Groq | `llama-3.1-8b-instant` — fastest, default |
| Medium | Groq | `llama-3.3-70b-versatile` |
| High | Groq | `openai/gpt-oss-120b` — Groq's largest standalone reasoning model |
| Ultra | Gemini | `gemini-2.5-pro`, falling back through `gemini-2.5-flash` → `gemini-2.0-flash` → `gemini-1.5-pro` if unavailable |

Drag the slider, or just say **"switch mode to quick/medium/high/ultra"**
(also understands "low" for quick and "max"/"maximum" for ultra) — both
paths do the same thing and stay in sync with each other. Quick/Medium/High
need a Groq API key; Ultra needs a Gemini API key instead (Settings,
one-time, get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
The slider stays disabled with a hint until at least one of the two keys is
saved; picking Quick/Medium/High automatically makes Groq the active
provider for general chat, picking Ultra does not (it only affects that one
tier). If Ultra is selected but no Gemini key is configured, switching to it
is rejected with a spoken prompt instead of silently falling back to a
different model.

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

The **📷 Camera Vision Harness** panel (left column, below the Steam
launcher) does two distinct things:

- **Live object detection** — opens your webcam and runs a TensorFlow.js/
  COCO-SSD detector over the feed, drawing bounding boxes and labels
  directly on the video in real time. No API key or LLM call involved.
  Click **OPEN CAMERA**, or say **"open camera"** / **"close camera"**
  (also understands "start/stop camera" and "turn on/off camera").
- **Ask a question about what the camera sees** — say things like **"how
  many fingers am I holding up"**, **"what am I holding"**, or **"what do
  you see"** and JARVIS captures a single frame and asks it to a
  vision-capable LLM (same Groq/OpenRouter vision path as Screen Vision
  below), speaking back the answer. Opens the camera automatically for the
  question if it wasn't already open, and closes it again afterward if so.

No API key or setup is required for either — just webcam permission the
first time. This is distinct from **Screen Vision** (`SCREEN_QUERY` —
"what's on my screen") below, which asks the same kind of question about a
screenshot of the screen instead of the webcam.

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
