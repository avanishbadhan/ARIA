/**
 * JARVIS Filesystem Harness — a small sandboxed `.md`-note store (JARVIS's own
 * scratchpad memory) living in the Electron main process under
 * `app.getPath('userData')/jarvis-notes/`. This renderer harness delegates all
 * four CRUD operations to the main-process IPC bridge (registerFilesIpc in
 * electron/main.cjs), which owns the real trust boundary: filename
 * sanitization, path-traversal rejection, size/count caps, and all actual
 * filesystem access. Mirrors the MapsHarness shape — an `_isElectron()` gate
 * plus a graceful "not available" fallback for plain dev-browser mode
 * (localhost:3000 without Electron). Holds no credentials and never touches
 * the filesystem directly.
 *
 * See docs/superpowers/specs/2026-08-19-jarvis-notes-filesystem-design.md.
 *
 * Outside Electron (plain browser dev mode) every method below falls back
 * to a localStorage sandbox with identical shapes and caps, so Memory
 * works everywhere.
 */

// localStorage sandbox backing the non-Electron fallback (same caps as the
// main-process sandbox: 200 notes, 100KB each). One JSON blob so a corrupt
// entry degrades to an empty shelf instead of throwing.
const LOCAL_NOTES_KEY = 'aria_notes_v1';
const LOCAL_MAX_NOTES = 200;
const LOCAL_MAX_BYTES = 100 * 1024;

export class FileSystemHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.files;
  }

  _notAvailable() {
    return { success: false, message: "File storage isn't available outside the ARIA desktop app, Sir." };
  }

  _store() {
    // 'electron' when the desktop files bridge is present, 'local' for the
    // localStorage sandbox (plain browser dev mode), null when neither.
    if (this._isElectron()) return 'electron';
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return 'local';
    } catch (e) {}
    return null;
  }

  _sanitizeLocal(filename) {
    // Mirrors sanitizeFilename in electron/main.cjs (lowercase, spaces to
    // dashes, strip the rest, force .md) plus strips one pre-existing .md
    // first, so re-saving a listed name ('wifi-password.md') stays
    // 'wifi-password.md' instead of corrupting into 'wifi-passwordmd.md'.
    // Throws on traversal/empty exactly like the main process.
    const rawName = String(filename || '');
    if (rawName.includes('..') || rawName.includes('/') || rawName.includes('\\')) {
      throw new Error('invalid filename: path traversal');
    }
    let base = rawName.toLowerCase();
    if (base.endsWith('.md')) base = base.slice(0, -3);
    base = base
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .replace(/\.+$/, '');
    if (!base) throw new Error('invalid filename: empty after sanitization');
    return `${base}.md`;
  }

  _readLocalNotes() {
    try {
      const rawNotes = localStorage.getItem(LOCAL_NOTES_KEY);
      if (!rawNotes) return {};
      const parsed = JSON.parse(rawNotes);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  _saveLocalNotes(notes) {
    localStorage.setItem(LOCAL_NOTES_KEY, JSON.stringify(notes));
  }

  _localPreview(content) {
    // Mirrors previewNote in electron/main.cjs: first non-empty line,
    // whitespace-collapsed, capped at 60 chars.
    const firstLine = String(content || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
    const collapsed = firstLine.replace(/\s+/g, ' ').trim();
    return collapsed.length > 60 ? collapsed.slice(0, 60) + '...' : collapsed;
  }

  async _localWrite(filename, content, overwrite = false) {
    let safe;
    try {
      safe = this._sanitizeLocal(filename);
    } catch (e) {
      return { success: false, message: "That isn't a usable note name, Sir." };
    }
    if (typeof content !== 'string' || content.length > LOCAL_MAX_BYTES) {
      return { success: false, message: 'That note is too long to save, Sir.' };
    }
    const notes = this._readLocalNotes();
    const exists = Boolean(notes[safe]);
    if (exists && !overwrite) {
      return { success: false, exists: true, filename: safe };
    }
    if (!exists && Object.keys(notes).length >= LOCAL_MAX_NOTES) {
      return { success: false, message: 'Your notes sandbox is full, Sir - delete an old note first.' };
    }
    try {
      notes[safe] = { content, modifiedAt: Date.now() };
      this._saveLocalNotes(notes);
      return { success: true, filename: safe };
    } catch (e) {
      return { success: false, message: "I wasn't able to save that note, Sir." };
    }
  }

  async _localRead(filename) {
    let safe;
    try {
      safe = this._sanitizeLocal(filename);
    } catch (e) {
      return { success: false, message: "That isn't a usable note name, Sir." };
    }
    const notes = this._readLocalNotes();
    if (!notes[safe]) return { success: false, message: "No note by that name, Sir." };
    return { success: true, content: notes[safe].content };
  }

  async _localList() {
    const notes = this._readLocalNotes();
    const files = Object.entries(notes)
      .map(([filename, note]) => ({
        filename,
        preview: this._localPreview(note && note.content),
        modifiedAt: (note && note.modifiedAt) || 0
      }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { success: true, files };
  }

  async _localDelete(filename) {
    let safe;
    try {
      safe = this._sanitizeLocal(filename);
    } catch (e) {
      return { success: false, message: "That isn't a usable note name, Sir." };
    }
    const notes = this._readLocalNotes();
    if (!notes[safe]) return { success: false, message: "No note by that name, Sir." };
    try {
      delete notes[safe];
      this._saveLocalNotes(notes);
      return { success: true };
    } catch (e) {
      return { success: false, message: "I wasn't able to delete that note, Sir." };
    }
  }

  /**
   * Writes a `.md` note. With `overwrite=false`, an existing file is not
   * touched — the harness reports `{success:false, exists:true, filename}`
   * so the caller can route through the spoken-confirmation flow.
   * @param {string} filename
   * @param {string} content
   * @param {boolean} overwrite
   * @returns {Promise<{success: boolean, filename: string}|{success: false, exists?: boolean, message: string}>}
   */
  async writeNote(filename, content, overwrite = false) {
    const store = this._store();
    if (store === 'local') return this._localWrite(filename, content, overwrite);
    if (store !== 'electron') return this._notAvailable();
    try {
      const data = await window.jarvisElectron.files.write(filename, content, overwrite);
      if (data?.success) {
        this.onLog({ type: 'SUCCESS', message: `[FILES] Note written: ${data.filename}` });
        return { success: true, filename: data.filename };
      }
      if (data?.exists) {
        return { success: false, exists: true, filename: data.filename };
      }
      this.onLog({ type: 'WARNING', message: `[FILES] writeNote failed: ${data?.message || 'unknown'}` });
      return { success: false, message: data?.message || "I wasn't able to save that note, Sir." };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[FILES] writeNote threw: ${err.message}` });
      return { success: false, message: "I wasn't able to save that note, Sir." };
    }
  }

  /**
   * Reads a `.md` note's content.
   * @param {string} filename
   * @returns {Promise<{success: boolean, content: string}|{success: false, message: string}>}
   */
  async readNote(filename) {
    const store = this._store();
    if (store === 'local') return this._localRead(filename);
    if (store !== 'electron') return this._notAvailable();
    try {
      const data = await window.jarvisElectron.files.read(filename);
      if (data?.success) {
        this.onLog({ type: 'SUCCESS', message: `[FILES] Note read: ${filename}` });
        return { success: true, content: data.content };
      }
      return { success: false, message: data?.message || "No note by that name, Sir." };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[FILES] readNote threw: ${err.message}` });
      return { success: false, message: "I wasn't able to read that note, Sir." };
    }
  }

  /**
   * Lists saved notes, most-recently-modified first.
   * @returns {Promise<{success: boolean, files: [{filename: string, preview: string, modifiedAt: number}]}|{success: false, message: string}>}
   */
  async listNotes() {
    const store = this._store();
    if (store === 'local') return this._localList();
    if (store !== 'electron') return this._notAvailable();
    try {
      const data = await window.jarvisElectron.files.list();
      if (data?.success) {
        return { success: true, files: data.files || [] };
      }
      return { success: false, message: data?.message || "I wasn't able to list your notes, Sir." };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[FILES] listNotes threw: ${err.message}` });
      return { success: false, message: "I wasn't able to list your notes, Sir." };
    }
  }

  /**
   * Deletes a `.md` note.
   * @param {string} filename
   * @returns {Promise<{success: boolean}|{success: false, message: string}>}
   */
  async deleteNote(filename) {
    const store = this._store();
    if (store === 'local') return this._localDelete(filename);
    if (store !== 'electron') return this._notAvailable();
    try {
      const data = await window.jarvisElectron.files.delete(filename);
      if (data?.success) {
        this.onLog({ type: 'SUCCESS', message: `[FILES] Note deleted: ${filename}` });
        return { success: true };
      }
      return { success: false, message: data?.message || "I wasn't able to delete that note, Sir." };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[FILES] deleteNote threw: ${err.message}` });
      return { success: false, message: "I wasn't able to delete that note, Sir." };
    }
  }
}
