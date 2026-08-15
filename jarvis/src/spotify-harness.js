/**
 * JARVIS Spotify Automation Harness
 * Opens the Spotify desktop app and plays songs via the `spotify:` URI
 * protocol. Exact-track resolution (auto-play) requires an optional Spotify
 * API key and Electron's main process (see spotifyResolveTrack in preload);
 * without either, falls back to opening Spotify pre-searched for the query.
 */

import { resolveWithLlmFallback } from './llm-entity-resolver.js';

export class SpotifyHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.resolveEntity = options.resolveEntity;
  }

  /**
   * Opens the Spotify desktop application via its URI protocol handler.
   */
  openApp() {
    this.onLog({
      type: 'HARNESS',
      message: '[SPOTIFY HARNESS] Initiating Spotify Application launch protocol...'
    });

    window.location.href = 'spotify:';

    return {
      success: true,
      message: 'Opening Spotify, Sir.'
    };
  }

  /**
   * Opens Spotify pre-searched for the query. Used whenever exact-track
   * resolution isn't possible or didn't find a match — never a dead end.
   */
  _openSearchFallback(query) {
    const spotifyUri = `spotify:search:${encodeURIComponent(query)}`;
    this.onLog({
      type: 'HARNESS',
      message: `[SPOTIFY HARNESS] Opening Spotify search for "${query}" (${spotifyUri})`
    });

    window.location.href = spotifyUri;

    return {
      success: false,
      usedFallback: true,
      query,
      message: `I've opened Spotify search for "${query}", Sir.`
    };
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.spotifyAuth;
  }

  /**
   * Checks whether the user has connected their own Spotify account (OAuth),
   * which is required to see their private playlists/saved albums — the
   * Client Credentials flow used by playSong() only authenticates the app
   * itself and can never see per-user library data.
   */
  async authStatus() {
    if (!this._isElectron()) return { authenticated: false };
    try {
      return await window.jarvisElectron.spotifyAuth.status();
    } catch (e) {
      return { authenticated: false };
    }
  }

  /**
   * Opens the system browser for the user to approve access, via a local
   * loopback OAuth redirect handled in the Electron main process.
   */
  async login(clientId, clientSecret) {
    if (!this._isElectron()) {
      throw new Error('Connecting your Spotify account requires the JARVIS desktop app.');
    }
    return window.jarvisElectron.spotifyAuth.login(clientId, clientSecret);
  }

  async logout() {
    if (!this._isElectron()) return { success: true };
    return window.jarvisElectron.spotifyAuth.logout();
  }

  /**
   * Fetches the connected user's own playlists and saved albums.
   */
  async getLibrary(clientId, clientSecret) {
    if (!this._isElectron()) return { playlists: [], albums: [] };
    return window.jarvisElectron.spotifyAuth.getLibrary(clientId, clientSecret);
  }

  _findBestMatch(items, query) {
    const normalizedQuery = (query || '').trim().toLowerCase();
    if (!items || !items.length) return null;
    if (!normalizedQuery) return items[0];

    const exact = items.find((item) => item.name?.toLowerCase() === normalizedQuery);
    if (exact) return exact;

    const contains = items.find((item) => item.name?.toLowerCase().includes(normalizedQuery));
    if (contains) return contains;

    const queryWords = normalizedQuery.split(/\s+/);
    let bestScore = 0;
    let best = null;
    for (const item of items) {
      const nameWords = (item.name || '').toLowerCase().split(/\s+/);
      const score = queryWords.filter((w) => nameWords.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  /**
   * Plays a playlist, album, or the Liked Songs collection from the user's
   * own connected Spotify library, matched by name against a fuzzy search.
   * Falls back to opening a plain Spotify search if not connected or no
   * match is found — never a dead end.
   */
  async playFromLibrary({ kind, query, alternatives = [] }, clientId, clientSecret) {
    if (!this._isElectron() || !clientId || !clientSecret) {
      this.onLog({
        type: 'WARNING',
        message: `[SPOTIFY LIBRARY] Falling back to search — ${!this._isElectron() ? 'Electron library bridge unavailable' : 'Client ID/Secret not configured'}.`
      });
      return this._openSearchFallback(query || 'liked songs');
    }

    try {
      if (kind === 'liked') {
        // Liked Songs has no context URI usable via the desktop URI
        // protocol — opening Spotify's built-in collection view is the
        // closest reliable equivalent.
        this.onLog({ type: 'HARNESS', message: '[SPOTIFY HARNESS] Opening Liked Songs...' });
        window.location.href = 'spotify:collection';
        return { success: true, message: 'Opening your Liked Songs, Sir.' };
      }

      const { authenticated } = await this.authStatus();
      if (!authenticated) {
        this.onLog({ type: 'WARNING', message: '[SPOTIFY LIBRARY] Account not connected — connect it in Settings first.' });
        return this._openSearchFallback(query);
      }

      const library = await this.getLibrary(clientId, clientSecret);
      const pool = kind === 'album' ? library.albums : library.playlists;
      let match = this._findBestMatch(pool, query);
      if (!match) {
        match = await resolveWithLlmFallback({
          query,
          alternatives,
          candidates: pool,
          kind: `Spotify ${kind}`,
          resolveEntity: this.resolveEntity,
          onLog: this.onLog
        });
      }

      if (!match) {
        this.onLog({ type: 'WARNING', message: `[SPOTIFY LIBRARY] No ${kind} matched "${query}" in your library.` });
        return this._openSearchFallback(query);
      }

      this.onLog({
        type: 'SUCCESS',
        message: `[SPOTIFY LIBRARY MATCH] "${match.name}" (${match.uri})`
      });

      window.location.href = match.uri;

      return {
        success: true,
        matchedName: match.name,
        uri: match.uri,
        message: `Playing your ${kind} "${match.name}", Sir.`
      };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[SPOTIFY LIBRARY FALLBACK] ${err.message}` });
      return this._openSearchFallback(query);
    }
  }

  /**
   * Resolves a song query to a track and plays it. With credentials and
   * running inside Electron, resolves the exact track via Spotify's Search
   * API and plays it directly. Otherwise falls back to opening Spotify
   * pre-searched for the query.
   */
  async playSong(query, clientId, clientSecret) {
    if (!clientId || !clientSecret || typeof window === 'undefined' || !window.jarvisElectron?.isElectron) {
      return this._openSearchFallback(query);
    }

    try {
      const track = await window.jarvisElectron.spotifyResolveTrack(clientId, clientSecret, query);
      if (!track) {
        return this._openSearchFallback(query);
      }

      this.onLog({
        type: 'SUCCESS',
        message: `[SPOTIFY MATCH] "${track.name}" by ${track.artist} (${track.uri})`
      });

      window.location.href = track.uri;

      return {
        success: true,
        trackName: track.name,
        artist: track.artist,
        uri: track.uri,
        message: `Playing "${track.name}" by ${track.artist}, Sir.`
      };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[SPOTIFY FALLBACK] ${err.message}` });
      return this._openSearchFallback(query);
    }
  }
}
