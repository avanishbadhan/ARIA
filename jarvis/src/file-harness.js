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
 */

export class FileSystemHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.files;
  }

  _notAvailable() {
    return { success: false, message: "File storage isn't available outside the JARVIS desktop app, Sir." };
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
    if (!this._isElectron()) return this._notAvailable();
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
    if (!this._isElectron()) return this._notAvailable();
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
    if (!this._isElectron()) return this._notAvailable();
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
    if (!this._isElectron()) return this._notAvailable();
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
