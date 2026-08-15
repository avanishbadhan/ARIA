/**
 * Shared caching + fuzzy-match skeleton for the per-platform game library
 * classes (SteamLibrary, EpicGamesLibrary, XboxLibrary). Subclasses
 * implement `_fetchFresh()`, returning a freshly-fetched, mapped game array,
 * or `null` to signal "unavailable right now" (already logged if that needs
 * explaining, e.g. Steam's "not configured" warning — silent otherwise,
 * e.g. not running inside Electron).
 */
import { fuzzyMatchGameName } from './game-name-matcher.js';

export class GameLibraryBase {
  constructor(options = {}, { cacheKey, logTag, displayName, fetchFailureMessage }) {
    this.onLog = options.onLog || (() => {});
    this.library = [];
    this.lastFetched = null;
    this.cacheKey = cacheKey;
    this.cacheMaxAgeMs = 1000 * 60 * 60; // 1 hour
    this._logTag = logTag;
    this._displayName = displayName;
    this._fetchFailureMessage = fetchFailureMessage;
  }

  async fetchLibrary(forceRefresh = false) {
    if (!forceRefresh && this.library.length > 0 && this.lastFetched && (Date.now() - this.lastFetched) < this.cacheMaxAgeMs) {
      return this.library;
    }

    if (!forceRefresh) {
      const cached = this._loadCache();
      if (cached) {
        this.library = cached;
        this.onLog({ type: 'HARNESS', message: `[${this._logTag}] Loaded ${this.library.length} games from cache.` });
        return this.library;
      }
    }

    try {
      const games = await this._fetchFresh();
      if (games === null) return [];

      this.library = games;
      this.lastFetched = Date.now();
      this._saveCache(this.library);
      this.onLog({ type: 'SUCCESS', message: `[${this._logTag}] Loaded ${this.library.length} games from your ${this._displayName} library.` });
      return this.library;
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[${this._logTag}] ${this._fetchFailureMessage}: ${err.message}` });
      return [];
    }
  }

  /**
   * Fuzzy-match a spoken game name against the loaded library.
   */
  findGame(query) {
    return fuzzyMatchGameName(query, this.library);
  }

  _loadCache() {
    try {
      const raw = localStorage.getItem(this.cacheKey);
      if (!raw) return null;
      const { ts, games } = JSON.parse(raw);
      if ((Date.now() - ts) > this.cacheMaxAgeMs) return null;
      this.lastFetched = ts;
      return games;
    } catch (e) {
      return null;
    }
  }

  _saveCache(library) {
    try {
      localStorage.setItem(this.cacheKey, JSON.stringify({ ts: Date.now(), games: library }));
    } catch (e) {
      console.warn(`Could not save ${this._displayName} library cache:`, e);
    }
  }
}
