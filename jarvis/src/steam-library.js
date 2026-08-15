/**
 * JARVIS Steam Library Integration
 * Fetches the user's full Steam game library via Steam Web API,
 * caches it in localStorage, and provides fuzzy name-to-AppID resolution
 * so any owned game can be launched by voice.
 */

import { GameLibraryBase } from './game-library-base.js';

export class SteamLibrary extends GameLibraryBase {
  constructor(options = {}) {
    super(options, {
      cacheKey: 'jarvis_steam_library_cache',
      logTag: 'STEAM LIBRARY',
      displayName: 'Steam',
      fetchFailureMessage: 'Failed to fetch library'
    });

    // Priority: constructor override (tests) > localStorage (set via UI) > empty
    this.apiKey = options.apiKey
      || localStorage.getItem('jarvis_steam_api_key')
      || '';
    this.steamId = options.steamId
      || localStorage.getItem('jarvis_steam_id')
      || '';
  }

  /**
   * Configure credentials and persist them
   */
  configure(apiKey, steamId) {
    this.apiKey = apiKey.trim();
    this.steamId = steamId.trim();
    localStorage.setItem('jarvis_steam_api_key', this.apiKey);
    localStorage.setItem('jarvis_steam_id', this.steamId);
    this.onLog({ type: 'SUCCESS', message: '[STEAM LIBRARY] Credentials saved to local storage.' });
  }

  isConfigured() {
    return Boolean(this.apiKey && this.steamId);
  }

  /**
   * Fetch full game library from Steam Web API.
   * Uses a CORS-friendly proxy pattern.
   */
  async _fetchFresh() {
    if (!this.isConfigured()) {
      this.onLog({ type: 'WARNING', message: '[STEAM LIBRARY] Steam API Key and Steam ID not configured. Cannot fetch library.' });
      return null;
    }

    this.onLog({ type: 'HARNESS', message: '[STEAM LIBRARY] Fetching your Steam library via Steam Web API...' });

    let data;
    if (typeof window !== 'undefined' && window.jarvisElectron?.isElectron) {
      // Running inside the Electron shell — fetch via the main process (plain
      // Node HTTPS request), which isn't subject to browser CORS at all.
      data = await window.jarvisElectron.fetchSteamLibrary(this.apiKey, this.steamId);
    } else {
      // Plain browser tab. Steam's API doesn't allow direct cross-origin
      // browser calls. In dev, route through Vite's own server proxy (see
      // vite.config.js) — no third-party dependency. In a built/static
      // deployment, fall back to a public CORS proxy (best-effort; these
      // are unreliable and can go down).
      const steamPath = `/IPlayerService/GetOwnedGames/v0001/?key=${this.apiKey}&steamid=${this.steamId}&include_appinfo=1&format=json`;
      const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
      const apiUrl = isDev
        ? `/steam-api${steamPath}`
        : `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://api.steampowered.com${steamPath}`)}`;

      const response = await fetch(apiUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      data = await response.json();
    }

    if (!data.response || !data.response.games) {
      throw new Error('Steam API returned no games. Check that your Steam profile games are set to Public.');
    }

    const games = data.response.games;
    const library = games.map(g => ({
      appid: String(g.appid),
      name: g.name,
      nameLower: g.name.toLowerCase(),
      playtimeForever: g.playtime_forever || 0
    }));

    // Sort by most played first for better fuzzy match priority
    library.sort((a, b) => b.playtimeForever - a.playtimeForever);

    return library;
  }

  /**
   * Returns a few most-played games for quick-access display
   */
  getTopGames(limit = 6) {
    return this.library.slice(0, limit);
  }

  clearCache() {
    localStorage.removeItem(this.cacheKey);
    this.library = [];
    this.lastFetched = null;
    this.onLog({ type: 'HARNESS', message: '[STEAM LIBRARY] Cache cleared.' });
  }
}
