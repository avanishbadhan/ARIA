/**
 * JARVIS Xbox Library Integration
 * Reads installed Xbox/Game Pass/Store titles via the Electron main process
 * (Get-AppxPackage + Get-StartApps — see electron/main.cjs's
 * xbox:get-installed-games handler), caches them in localStorage, and
 * provides fuzzy name resolution for voice-triggered launches.
 */
import { GameLibraryBase } from './game-library-base.js';

export class XboxLibrary extends GameLibraryBase {
  constructor(options = {}) {
    super(options, {
      cacheKey: 'jarvis_xbox_library_cache',
      logTag: 'XBOX LIBRARY',
      displayName: 'Xbox',
      fetchFailureMessage: 'Failed to read installed games'
    });
  }

  async _fetchFresh() {
    if (typeof window === 'undefined' || !window.jarvisElectron?.isElectron) return null;

    const rawGames = await window.jarvisElectron.xboxGetInstalledGames();
    return rawGames.map(g => ({
      name: g.name,
      nameLower: g.name.toLowerCase(),
      appId: g.appId
    }));
  }
}
