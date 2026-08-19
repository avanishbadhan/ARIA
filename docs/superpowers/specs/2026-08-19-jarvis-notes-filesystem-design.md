# JARVIS Notes Filesystem — Design Spec

**Date:** 2026-08-19
**Status:** Approved

## Problem Statement

JARVIS has no persistent memory beyond the current conversation. The user wants JARVIS to be able to save and recall its own notes as `.md` files in a small sandboxed directory, with full tool-calling support so JARVIS can write, read, list, and delete notes autonomously during conversation (e.g. "make a note that...", "what did I save about X", "clean up that note").

## Decisions

- **Primary use case:** JARVIS's own notes/memory — an organic scratchpad the model reaches for mid-conversation, not a user-facing document editor.
- **Operations:** Full CRUD — write (create/overwrite), read, list, delete.
- **Destructive-action safety:** Overwriting an existing file or deleting a file requires a spoken confirmation round-trip before it happens. Fresh writes (new filename) and reads/list execute immediately, same as other autonomous tools.
- **Routing:** All four operations are exposed as autonomous LLM grounding tools (`GROUNDING_TOOLS` in `jarvis-tools.js`), the same mechanism as `find_nearby_places`/`get_weather` — not a pre-classified voice-command intent like `CAMERA_START`. This is a deliberate, narrow exception to that file's existing "read-only, no system state changes" comment: writes are confined entirely to an isolated sandbox directory, are reversible (nothing launches, nothing leaves the sandbox), and the intended use is exactly the kind of organic "remember this" moment that only works if the model can decide to call it mid-turn.
- **Storage location:** `app.getPath('userData')/jarvis-notes/`, mirroring the existing convention for `spotify-tokens.bin`/`google-tokens.bin`.
- **Scope:** Flat directory, `.md` files only, no subfolders, no full-text search across notes — v1 stays small per the original ask.

## Architecture

### New files
- `jarvis/src/file-harness.js` — `FileSystemHarness` (renderer). Same shape as `MapsHarness`/`WeatherHarness`: `_isElectron()` gate checking `window.jarvisElectron?.files`, `_notAvailable()` fallback, and four async methods (`writeNote`, `readNote`, `listNotes`, `deleteNote`) that delegate to the IPC bridge, catch errors, and return `{success, ...}` shapes. Never touches the filesystem directly — no credentials, no CORS concerns, consistent with every other harness in this codebase.

### `electron/main.cjs` additions
- `NOTES_DIR = path.join(app.getPath('userData'), 'jarvis-notes')`, created on demand (`fs.mkdirSync(NOTES_DIR, { recursive: true })`) the first time it's needed.
- `sanitizeFilename(name)` — the actual trust boundary. Lowercases, replaces whitespace with `-`, strips everything outside `[a-z0-9-_]`, forces a `.md` extension, and rejects the result outright (throws) if it's empty, or if the raw input contained `..`, `/`, or `\`. This runs in the main process regardless of what the renderer/LLM passed in — the LLM's suggested filename is never trusted as a real path.
- `MAX_NOTE_BYTES = 100 * 1024` and `MAX_NOTE_COUNT = 200` — content over the size cap is rejected; writing a new file when the directory is already at the count cap is rejected. Both return a clear error message rather than throwing past the IPC boundary.
- `registerFilesIpc()` with four handlers:
  - `files:write` `{filename, content, overwrite}` → sanitizes filename, checks existing-file/overwrite semantics (see Confirmation Flow), enforces size cap, writes via `fs.writeFileSync`, returns `{success, filename}`.
  - `files:read` `{filename}` → sanitizes filename, reads if present, returns `{success, content}` or `{success:false, message:"no such note"}`.
  - `files:list` → reads directory, returns `{success, files:[{filename, preview, modifiedAt}]}` sorted by most-recently-modified. `preview` is the first ~60 chars of content (first non-empty line, whitespace-collapsed).
  - `files:delete` `{filename}` → sanitizes filename, `fs.unlinkSync` if present, returns `{success}` or a not-found message.
  - Registered in `app.whenReady()` next to `registerWeatherIpc()`/`registerMapsIpc()`.

### `electron/preload.cjs` addition
```js
files: {
  write: (filename, content, overwrite) => ipcRenderer.invoke('files:write', { filename, content, overwrite }),
  read: (filename) => ipcRenderer.invoke('files:read', { filename }),
  list: () => ipcRenderer.invoke('files:list'),
  delete: (filename) => ipcRenderer.invoke('files:delete', { filename })
}
```

### `jarvis-tools.js` additions
Four new `GROUNDING_TOOLS` entries and matching executor branches, following the existing `find_nearby_places`/`get_directions` pattern (including a `files` param added to `createToolExecutor`'s destructure):

- **`write_note`** — `{ filename: string, content: string }`. Calls `files.writeNote(filename, content, /*overwrite*/ false)` first. If the harness reports the file already exists, the executor does **not** write; instead it sets `jarvis.pendingFileAction` (see below, executor needs access to the `jarvis` instance or a callback for this — passed into `createToolExecutor` as a new `setPendingFileAction` param) and returns a string instructing the model to ask the user to confirm the overwrite.
- **`read_note`** — `{ filename: string }`. Returns the file content, or a "no note by that name" message, optionally suggesting the model call `list_notes` first if unsure of the exact name.
- **`list_notes`** — `{}`. Returns a formatted list of `filename — preview (modified when)` lines, or "no notes saved yet".
- **`delete_note`** — `{ filename: string }`. Never deletes directly — always sets `pendingFileAction` (type `delete`) and returns a confirmation-request string, exactly like the overwrite case.

### `jarvis-core.js` additions
- Instantiate `this.fileHarness = new FileSystemHarness(...)`, pass `files: this.fileHarness` into `createToolExecutor(...)`.
- New state: `this.pendingFileAction = null`. Shape: `{ type: 'overwrite' | 'delete', filename: string, content?: string, expiresAt: number }` (TTL ~2 minutes, `Date.now() + 120000`).
- `createToolExecutor` gets a `setPendingFileAction: (action) => { this.pendingFileAction = action; }` callback so the tool executor (which is provider-agnostic and doesn't hold a `jarvis` reference) can set this state without a circular dependency.
- At the **top** of `processUserInput`, before intent classification: if `this.pendingFileAction` exists and hasn't expired, interpret the current input as a yes/no response to it instead of running normal classification:
  - Affirmative match (`/^(yes|yeah|yep|confirm|do it|go ahead|overwrite|delete it)\b/i` or similar) → perform the stashed action directly via the harness (`files.writeNote(filename, content, true)` or `files.deleteNote(filename)`), speak a confirmation of what happened, clear `pendingFileAction`, return.
  - Anything else → clear `pendingFileAction`, speak a short "Cancelled, Sir." acknowledgment, and **fall through to normal processing** of the utterance as a new request (so declining doesn't swallow an unrelated command the user actually meant).
  - Expired (past `expiresAt`) → silently clear `pendingFileAction` and fall through to normal processing.
- Own-knowledge/system prompt gets a short addition (matching the existing weather/maps nudge pattern) telling the model these tools exist and to use them proactively when the user asks it to remember, save, recall, or list something, and to never fabricate note content it hasn't actually read via `read_note`.

## Data Flow Examples

**"Make a note that the wifi password is hunter2"**
1. Classifier likely returns `CONVERSATIONAL` or `GOOGLE_SEARCH` (no dedicated intent) → falls into the LLM completion path with grounding tools available.
2. Model calls `write_note({filename: "wifi-password", content: "wifi password: hunter2"})`.
3. Executor → `files.writeNote(...)` → main process sanitizes filename → `wifi-password.md`, doesn't exist yet → writes → `{success:true}`.
4. Model responds "Noted, Sir."

**"Make a note called wifi-password" (again, different content)**
1. Model calls `write_note({filename: "wifi-password", content: "..."})`.
2. Executor detects existing file → sets `pendingFileAction = {type:'overwrite', filename:'wifi-password.md', content, expiresAt}` → returns "A note named 'wifi-password' already exists — ask the user to confirm before overwriting it."
3. Model speaks: "I already have a note called wifi-password, Sir — shall I overwrite it?"
4. User says "yes" → next `processUserInput` sees `pendingFileAction`, matches affirmative → `files.writeNote(filename, content, true)` → speaks "Done, overwritten, Sir."

**"What notes do I have saved?"**
1. Model calls `list_notes()` → returns formatted list → model reads it back conversationally.

## Error Handling

| Condition | Behavior |
|---|---|
| Not running in Electron | `"File storage isn't available outside the JARVIS desktop app, Sir."` |
| Invalid/empty filename after sanitization | Tool returns a rejection string; nothing written |
| Path traversal attempt (`..`, `/`, `\` in raw filename) | Rejected in `sanitizeFilename`, same rejection string, logged as WARNING |
| Content exceeds `MAX_NOTE_BYTES` | Rejected with a "too long to save" message |
| Note-count cap reached on a new file | Rejected with a "sandbox is full" message suggesting deletion of old notes |
| `read_note`/`delete_note` on nonexistent file | "No note by that name, Sir." (list_notes suggested) |
| Filesystem error (disk, permissions) | Caught, logged via `onLog` WARNING, generic "wasn't able to save/read that note" message — never throws past the tool executor |
| `pendingFileAction` present but expired | Silently cleared, input processed normally |

## Testing Plan

- `jarvis/test/file-harness.test.js` — success/failure/not-available cases for all four `FileSystemHarness` methods (mirrors `maps-harness.test.js`).
- `jarvis/test/jarvis-tools.test.js` additions — executor dispatch tests for `write_note`/`read_note`/`list_notes`/`delete_note`, including the "existing file → pending action set, no write occurs" branch.
- `jarvis/test/jarvis-core.notes-routing.test.js` (new) — pending-confirmation round trip: write→exists→confirm→overwrites; write→exists→decline→unchanged, falls through; write→exists→unrelated new command→cancels pending AND handles the new command; TTL expiry→falls through to normal processing.
- Manual sanity check in `electron/main.cjs` sandboxing logic (`sanitizeFilename`) via a standalone `node -e` check for traversal inputs like `../../evil`, `a/b.md`, `con.md` (reserved Windows name — accept as-is since it's just a data filename under our own dir, not opened as a device), before wiring into IPC.

## Out of Scope for v1

- Subfolders / nested organization
- Non-`.md` file types
- Full-text search across notes (model uses `list_notes` + `read_note` on candidates)
- In-place editing/diffing (overwrite replaces the whole file)
- Exporting/syncing notes outside the sandbox
- A general-purpose confirmation framework (this TTL/pending-action mechanism is scoped specifically to file actions)
