/**
 * JARVIS Location Harness — resolves the user's current position once via
 * the standard Chromium `navigator.geolocation` API and exposes it as a
 * promise. Unlike GmailHarness/GoogleCalendarHarness/SpotifyHarness this
 * harness has no Electron IPC bridge and no `_isElectron()` branch:
 * `navigator.geolocation` is available identically in the dev-browser mode
 * (`localhost:3000`) and the packaged Electron app, so there's nothing for
 * preload.cjs to bridge.
 *
 * `getCurrentPosition()` always resolves (never rejects) — on denial,
 * timeout, or unsupported it returns `{ success: false, message }` so the
 * renderer's map panel degrades gracefully to a status line instead of
 * throwing an unhandled error. One-shot only; no continuous tracking.
 */

export class LocationHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.geolocation;
  }

  _messageForError(err) {
    switch (err && err.code) {
      case err && err.PERMISSION_DENIED:
        return "You've blocked location access, Sir. I can't pinpoint you without it.";
      case err && err.TIMEOUT:
        return "I couldn't lock onto your location in time, Sir.";
      case err && err.POSITION_UNAVAILABLE:
        return "I wasn't able to determine your position, Sir.";
      default:
        return "I wasn't able to get your location, Sir.";
    }
  }

  /**
   * Resolves the user's current coordinates. Resolves (never rejects) with
   * `{ success: true, lat, lon }` on success or `{ success: false, message }`
   * on permission-denied, timeout, position-unavailable, or unsupported.
   */
  getCurrentPosition() {
    if (!this._isSupported()) {
      this.onLog({ type: 'WARNING', message: '[LOCATION] Geolocation not supported by this environment.' });
      return Promise.resolve({ success: false, message: "Your browser doesn't support location services, Sir." });
    }

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          this.onLog({ type: 'SUCCESS', message: `[LOCATION] Position locked: ${lat.toFixed(5)}, ${lon.toFixed(5)}.` });
          resolve({ success: true, lat, lon });
        },
        (err) => {
          this.onLog({ type: 'WARNING', message: `[LOCATION] Position unavailable: ${err.message}` });
          resolve({ success: false, message: this._messageForError(err) });
        }
      );
    });
  }
}
