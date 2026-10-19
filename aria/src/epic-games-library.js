/**
 * JARVIS Epic Games Library Integration
 * Reads installed games from Epic Games Launcher's local manifest files
 * (via the Electron main process — see electron/main.cjs's
 * epic:get-installed-games handler), caches them in localStorage, and
 * provides fuzzy name resolution for voice-triggered launches.
 */
import { GameLibraryBase } from './game-library-base.js';

export class EpicGamesLibrary extends GameLibraryBase {
  constructor(options = {}) {
    super(options, {
      cacheKey: 'jarvis_epic_library_cache',
      logTag: 'EPIC LIBRARY',
      displayName: 'Epic Games',
      fetchFailureMessage: 'Failed to read installed games'
    });
  }

  async _fetchFresh() {
    if (typeof window === 'undefined' || !window.jarvisElectron?.isElectron) return null;

    const rawGames = await window.jarvisElectron.epicGetInstalledGames();
    return rawGames.map(g => ({
      name: g.displayName,
      nameLower: g.displayName.toLowerCase(),
      appName: g.appName,
      catalogNamespace: g.catalogNamespace,
      catalogItemId: g.catalogItemId
    }));
  }
}
