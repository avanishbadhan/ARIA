/**
 * Generic Google OAuth account connector for JARVIS. Gmail-agnostic on
 * purpose — GmailHarness is its first consumer, but a future Calendar/Drive
 * harness reuses this same connector without touching this file. Mirrors
 * SpotifyHarness's auth-only surface (authStatus/login/logout); the actual
 * OAuth loopback flow lives in electron/main.cjs, this is just the bridge.
 */

export class GoogleAccountConnector {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.googleAuth;
  }

  /**
   * Whether the user has connected their own Google account (OAuth) — read
   * operations against Gmail require this; there is no anonymous fallback
   * the way Spotify's Client Credentials flow provides one.
   */
  async authStatus() {
    if (!this._isElectron()) return { authenticated: false };
    try {
      return await window.jarvisElectron.googleAuth.status();
    } catch (e) {
      return { authenticated: false };
    }
  }

  /**
   * Opens the system browser for the user to approve access, via a local
   * loopback OAuth redirect handled in the Electron main process. Only ever
   * called from an explicit Settings button click — never voice, never
   * model-initiated.
   */
  async login(clientId, clientSecret) {
    if (!this._isElectron()) {
      throw new Error('Connecting your Google account requires the ARIA desktop app.');
    }
    return window.jarvisElectron.googleAuth.login(clientId, clientSecret);
  }

  async logout() {
    if (!this._isElectron()) return { success: true };
    return window.jarvisElectron.googleAuth.logout();
  }
}
