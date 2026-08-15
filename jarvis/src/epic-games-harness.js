/**
 * JARVIS Epic Games Automation Harness
 * Opens the Epic Games Launcher via its `com.epicgames.launcher://` URI
 * protocol handler, and launches a specific installed game (resolved via
 * an injected EpicGamesLibrary) — see
 * docs/superpowers/specs/2026-08-12-cross-platform-game-launcher-design.md.
 */

import { resolveWithLlmFallback } from './llm-entity-resolver.js';

export class EpicGamesHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.epicGamesLibrary = options.epicGamesLibrary;
    this.resolveEntity = options.resolveEntity;
  }

  /**
   * Opens the Epic Games Launcher via its URI protocol handler.
   */
  openApp() {
    this.onLog({
      type: 'HARNESS',
      message: '[EPIC GAMES HARNESS] Initiating Epic Games Launcher launch protocol...'
    });

    window.location.href = 'com.epicgames.launcher://start';

    return {
      success: true,
      message: 'Opening Epic Games Launcher, Sir.'
    };
  }

  /**
   * Resolves a game name against the user's installed Epic Games library
   * and launches it via com.epicgames.launcher://apps/<namespace>:<itemid>:<appname>.
   * No search-fallback when not found — see the design spec's Non-goals.
   */
  async launchGame(gameQuery, alternatives = []) {
    const games = await this.epicGamesLibrary.fetchLibrary();
    let match = games.length ? this.epicGamesLibrary.findGame(gameQuery) : null;
    if (!match && games.length) {
      match = await resolveWithLlmFallback({
        query: gameQuery,
        alternatives,
        candidates: games,
        kind: 'Epic Games game to launch',
        resolveEntity: this.resolveEntity,
        onLog: this.onLog
      });
    }

    if (!match) {
      this.onLog({ type: 'WARNING', message: `[EPIC GAMES HARNESS] "${gameQuery}" not found in your Epic Games library.` });
      return { success: false, gameName: gameQuery, message: `I could not find "${gameQuery}" in your Epic Games library, Sir.` };
    }

    const epicUri = `com.epicgames.launcher://apps/${match.catalogNamespace}%3A${match.catalogItemId}%3A${match.appName}?action=launch&silent=true`;
    this.onLog({ type: 'HARNESS', message: `[EPIC LIBRARY MATCH] ${match.name} (${match.appName})` });
    this.onLog({ type: 'SUCCESS', message: `[GAME LAUNCH PROTOCOL] Executing: ${epicUri}` });
    window.location.href = epicUri;

    return {
      success: true,
      gameName: match.name,
      appName: match.appName,
      source: 'epic_library',
      protocol: epicUri,
      message: `Launching ${match.name} on Epic Games, Sir.`
    };
  }
}
