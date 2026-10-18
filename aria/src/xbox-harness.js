/**
 * JARVIS Xbox App Automation Harness
 * Opens the Xbox app (Windows) via its `xbox:` URI protocol handler, and
 * launches a specific installed game (resolved via an injected XboxLibrary,
 * launched through shell:AppsFolder) — see
 * docs/superpowers/specs/2026-08-12-cross-platform-game-launcher-design.md.
 */

import { resolveWithLlmFallback } from './llm-entity-resolver.js';

export class XboxHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.xboxLibrary = options.xboxLibrary;
    this.resolveEntity = options.resolveEntity;
  }

  /**
   * Opens the Xbox app via its URI protocol handler.
   */
  openApp() {
    this.onLog({
      type: 'HARNESS',
      message: '[XBOX HARNESS] Initiating Xbox App launch protocol...'
    });

    window.location.href = 'xbox:';

    return {
      success: true,
      message: 'Opening Xbox App, Sir.'
    };
  }

  /**
   * Resolves a game name against the user's installed Xbox/Store library
   * and launches it via shell:AppsFolder\<appId> (through the Electron main
   * process — this isn't a registered URL protocol like xbox:/spotify:, so
   * it can't go through window.location.href). No search-fallback when not
   * found — see the design spec's Non-goals.
   */
  async launchGame(gameQuery, alternatives = []) {
    const games = await this.xboxLibrary.fetchLibrary();
    let match = games.length ? this.xboxLibrary.findGame(gameQuery) : null;
    if (!match && games.length) {
      match = await resolveWithLlmFallback({
        query: gameQuery,
        alternatives,
        candidates: games,
        kind: 'Xbox game to launch',
        resolveEntity: this.resolveEntity,
        onLog: this.onLog
      });
    }

    if (!match) {
      this.onLog({ type: 'WARNING', message: `[XBOX HARNESS] "${gameQuery}" not found in your Xbox library.` });
      return { success: false, gameName: gameQuery, message: `I could not find "${gameQuery}" in your Xbox library, Sir.` };
    }

    if (!this._isElectron()) {
      this.onLog({ type: 'WARNING', message: '[XBOX HARNESS] Game launching requires the JARVIS desktop app.' });
      return { success: false, gameName: match.name, message: 'Launching Xbox games requires the desktop app, Sir.' };
    }

    this.onLog({ type: 'HARNESS', message: `[XBOX LIBRARY MATCH] ${match.name} (${match.appId})` });
    const launchResult = await window.jarvisElectron.xboxLaunchApp(match.appId);

    if (!launchResult || !launchResult.success) {
      this.onLog({ type: 'WARNING', message: `[XBOX HARNESS] Launch bridge reported failure for ${match.name} (${match.appId}).` });
      return { success: false, gameName: match.name, message: `I found ${match.name} in your Xbox library, Sir, but the launch failed.` };
    }

    this.onLog({ type: 'SUCCESS', message: `[GAME LAUNCH PROTOCOL] shell:AppsFolder\\${match.appId}` });

    return {
      success: true,
      gameName: match.name,
      appId: match.appId,
      source: 'xbox_library',
      message: `Launching ${match.name} on Xbox, Sir.`
    };
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron;
  }
}
