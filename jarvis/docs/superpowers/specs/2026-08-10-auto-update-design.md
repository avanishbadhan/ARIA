# Auto-Update (Major/Minor Split) — Design

**Goal:** JARVIS checks GitHub Releases for new versions and can update itself without the user re-running the installer manually.

## Architecture

- **`electron-updater`** (companion to the `electron-builder` we already use) checks a **GitHub Releases** feed on the existing public repo (`Taksh-Biyani/jarvis-voice-ai`). No custom update server.
- **Main process** (`electron/main.cjs`): owns the `autoUpdater` instance. Listens for `checking-for-update`, `update-available`, `download-progress`, `update-downloaded`, `error`, and forwards state to the renderer via `webContents.send('update:state', {...})`. Exposes two `ipcMain.handle` endpoints:
  - `update:check` — manually triggers a check (used by the Settings button)
  - `update:download` — manually triggers a download of an already-detected minor update
  - `update:install` — calls `autoUpdater.quitAndInstall()`
  - `update:get-version` — returns `app.getVersion()`
- **Preload** (`electron/preload.cjs`): bridges the above onto `window.electronAPI.update.*`, plus a subscription method for the `update:state` push event, following the existing bridge pattern already used for mic/Steam IPC.
- **Renderer**: new `src/update-manager.js` holds the pure classification logic and a thin wrapper around `window.electronAPI.update`; `src/main.js` wires it into a new "🔄 Software Update" Settings section and a badge dot on the ⚙️ SETTINGS header button.

## Version Classification

`classifyUpdate(currentVersion, latestVersion)` — pure function, unit-testable:
- Parses both as semver (`major.minor.patch`).
- Returns `'none'` if latest <= current.
- Returns `'major'` if `latest.major > current.major`.
- Returns `'minor'` otherwise (covers both minor and patch bumps).

## Behavior by classification

| Trigger | `'none'` | `'minor'` | `'major'` |
|---|---|---|---|
| Silent launch check | status: up to date | passive badge + "Download Update" button in Settings | auto-downloads in background, badge shown |
| Manual "Check for Updates" click | same as above | same (this check IS the manual trigger — but download still needs its own click, per the minor rule) | same auto-download behavior |

Downloading a minor update always requires a click (`update:download`), whether that click is the initial "Check for Updates" discovering it live, or a follow-up "Download Update" click if it was found via a silent background check. A major update never needs a download click — only the final `Restart & Install` click, which is required for **both** major and minor once the file is ready (installs are always explicit).

## UI States (Settings → 🔄 Software Update section)

| State | Status text | Button |
|---|---|---|
| Idle / up to date | "You're up to date (v1.0.0)" | `Check for Updates` |
| Checking | "Checking for updates…" | disabled |
| Minor found, not downloaded | "Update available (v1.1.0)" | `Download Update` |
| Downloading | "Downloading update… 42%" | disabled, progress bar |
| Ready | "Update ready (v1.1.0) — restart to install" | `Restart & Install` |
| Error | "Update check failed — try again" | `Check for Updates` |

A small badge dot appears on the ⚙️ SETTINGS header button whenever state is "Minor found" or "Ready", so it's discoverable without opening the modal.

## Error Handling

- Silent launch check failure (no network, GitHub unreachable/rate-limited): logged to the console panel only; UI stays at "up to date" — consistent with how Steam library fetch failures are handled today.
- Manual check failure: status shows "Update check failed — try again", button reverts to `Check for Updates`.
- Download failure (`autoUpdater`'s `error` event, includes checksum mismatches against `latest.yml`): reverts to the pre-download state rather than a stuck spinner. No resume logic — app closed mid-download just restarts the check next launch (YAGNI).
- **Draft-release gotcha**: `electron-updater` cannot see GitHub releases published as drafts. The release script below uses `--publish always`, which publishes live (non-draft) — documented in the README so this doesn't silently look like "no update found."

## Release Publishing Workflow (manual, local)

1. Bump `"version"` in `package.json`.
2. `package.json`'s `build` block gets a `publish` target:
   ```json
   "publish": { "provider": "github", "owner": "Taksh-Biyani", "repo": "jarvis-voice-ai" }
   ```
3. New script: `"electron:release": "vite build && electron-builder --win --publish always"`.
4. One-time: generate a GitHub PAT (`repo` scope or fine-grained Contents: Read/Write on this repo), set as `$env:GH_TOKEN` in the shell before running `npm run electron:release`. Documented step-by-step in README.

## Testing

`autoUpdater` itself needs a packaged app + real/mocked GitHub feed, so it isn't unit-testable under `node --test` (same category as `steam-harness.js`). What *is* unit-tested: `classifyUpdate()` in `src/update-manager.js` — pure function, all three branches (`none`/`minor`/`major`) plus edge cases (equal versions, multi-digit version jumps). IPC wiring and the actual `autoUpdater` behavior get manual verification when a real release is cut.
