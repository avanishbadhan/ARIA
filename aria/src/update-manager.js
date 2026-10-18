/**
 * Thin renderer-side wrapper around the Electron auto-updater IPC bridge
 * (electron/preload.cjs -> electron/main.cjs). No-ops when not running
 * inside Electron (e.g. `npm run dev` in a plain browser tab), since
 * there's no packaged installer to update there.
 */

export function isUpdateSupported() {
  return typeof window !== 'undefined' && !!window.jarvisElectron?.update;
}

export function getCurrentVersion() {
  if (!isUpdateSupported()) return Promise.resolve(null);
  return window.jarvisElectron.update.getVersion();
}

export function checkForUpdate() {
  if (!isUpdateSupported()) return;
  window.jarvisElectron.update.check();
}

export function downloadUpdate() {
  if (!isUpdateSupported()) return;
  window.jarvisElectron.update.download();
}

export function installUpdate() {
  if (!isUpdateSupported()) return;
  window.jarvisElectron.update.install();
}

/** Returns an unsubscribe function, or a no-op if unsupported. */
export function onUpdateState(callback) {
  if (!isUpdateSupported()) return () => {};
  return window.jarvisElectron.update.onState(callback);
}

/** Returns [{version, notes}, ...] from GitHub Releases, newest first, or [] if unsupported/failed. */
export function getChangelog() {
  if (!isUpdateSupported()) return Promise.resolve([]);
  return window.jarvisElectron.update.getChangelog();
}
