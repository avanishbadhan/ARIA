/**
 * JARVIS Steam Automation & Game Launcher Harness
 * Launches Steam application and triggers games via Windows `steam://` protocol handlers.
 * Integrates with SteamLibrary for real-library lookups.
 */

import { SteamLibrary } from './steam-library.js';
import { resolveWithLlmFallback } from './llm-entity-resolver.js';

export class SteamHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.onStatusUpdate = options.onStatusUpdate || (() => {});
    this.resolveEntity = options.resolveEntity;
    this.steamLibrary = new SteamLibrary({ onLog: this.onLog });

    // Mapping of popular Steam game names and variations to Steam AppIDs
    this.gameDatabase = {
      "counter strike": { id: "730", name: "Counter-Strike 2", genre: "FPS" },
      "csgo": { id: "730", name: "Counter-Strike 2", genre: "FPS" },
      "cs2": { id: "730", name: "Counter-Strike 2", genre: "FPS" },
      "counter-strike 2": { id: "730", name: "Counter-Strike 2", genre: "FPS" },
      "dota": { id: "570", name: "Dota 2", genre: "MOBA" },
      "dota 2": { id: "570", name: "Dota 2", genre: "MOBA" },
      "cyberpunk": { id: "1091500", name: "Cyberpunk 2077", genre: "RPG" },
      "cyberpunk 2077": { id: "1091500", name: "Cyberpunk 2077", genre: "RPG" },
      "elden ring": { id: "1245620", name: "Elden Ring", genre: "Action RPG" },
      "gta": { id: "271590", name: "Grand Theft Auto V", genre: "Action" },
      "gta 5": { id: "271590", name: "Grand Theft Auto V", genre: "Action" },
      "gta v": { id: "271590", name: "Grand Theft Auto V", genre: "Action" },
      "grand theft auto": { id: "271590", name: "Grand Theft Auto V", genre: "Action" },
      "apex": { id: "1172470", name: "Apex Legends", genre: "Battle Royale" },
      "apex legends": { id: "1172470", name: "Apex Legends", genre: "Battle Royale" },
      "team fortress": { id: "440", name: "Team Fortress 2", genre: "FPS" },
      "tf2": { id: "440", name: "Team Fortress 2", genre: "FPS" },
      "baldurs gate": { id: "1086940", name: "Baldur's Gate 3", genre: "RPG" },
      "baldur's gate 3": { id: "1086940", name: "Baldur's Gate 3", genre: "RPG" },
      "rocket league": { id: "252950", name: "Rocket League", genre: "Sports" },
      "pubg": { id: "578080", name: "PUBG: BATTLEGROUNDS", genre: "Battle Royale" },
      "rust": { id: "252490", name: "Rust", genre: "Survival" },
      "destiny 2": { id: "1085660", name: "Destiny 2", genre: "FPS" },
      "terraria": { id: "105600", name: "Terraria", genre: "Sandbox" },
      "palworld": { id: "1623730", name: "Palworld", genre: "Action RPG" },
      "helldivers": { id: "553850", name: "HELLDIVERS 2", genre: "Action" },
      "helldivers 2": { id: "553850", name: "HELLDIVERS 2", genre: "Action" },
      "half life": { id: "70", name: "Half-Life", genre: "FPS" },
      "half life 2": { id: "220", name: "Half-Life 2", genre: "FPS" },
      "portal 2": { id: "620", name: "Portal 2", genre: "Puzzle" },
      "stardew valley": { id: "413150", name: "Stardew Valley", genre: "Simulation" }
    };
  }

  /**
   * Detects explicit Steam launch commands in user input.
   */
  detectCommand(input) {
    const text = input.trim().toLowerCase();

    // 1. Launch main Steam client
    if (text.match(/^(open|launch|start|run)\s+steam$/i) || text === "steam") {
      return { type: 'LAUNCH_STEAM' };
    }

    // 2. Open specific Steam section (store, library, news, friends)
    const sectionMatch = text.match(/(?:open|launch|go to|show)\s+steam\s+(store|library|friends|news|community|settings)/i);
    if (sectionMatch && sectionMatch[1]) {
      return {
        type: 'OPEN_STEAM_SECTION',
        section: sectionMatch[1].toLowerCase()
      };
    }

    // 3. Play or launch a specific game
    const gameMatch = text.match(/(?:play|launch|start|run|open)\s+(?:game\s+)?([a-z0-9\s':\-]+)/i);
    if (gameMatch && gameMatch[1]) {
      const query = gameMatch[1].trim();
      if (query !== "steam" && query !== "google" && query !== "youtube" && query !== "browser") {
        return {
          type: 'LAUNCH_GAME',
          gameQuery: query
        };
      }
    }

    return null;
  }

  /**
   * Launches main Steam application via URI handler
   */
  launchSteam() {
    this.onLog({
      type: 'HARNESS',
      message: `[STEAM HARNESS] Initiating Steam Application launch protocol...`
    });

    const steamUri = "steam://open/main";
    window.location.href = steamUri;

    this.onLog({
      type: 'SUCCESS',
      message: `[STEAM EXECUTION] Sent protocol signal: ${steamUri}. Opening Steam Client.`
    });

    return {
      success: true,
      protocol: steamUri,
      message: "Steam client launch initiated."
    };
  }

  /**
   * Pass a configured SteamLibrary instance in (called from JarvisCore after init)
   */
  setLibrary(lib) {
    this.steamLibrary = lib;
  }

  /**
   * Opens specific section in Steam
   */
  openSteamSection(section) {
    const sectionMap = {
      store: "steam://store",
      library: "steam://open/games",
      friends: "steam://open/friends",
      news: "steam://open/news",
      community: "steam://url/SteamIDPage",
      settings: "steam://open/settings"
    };

    const steamUri = sectionMap[section] || "steam://open/main";
    this.onLog({
      type: 'HARNESS',
      message: `[STEAM HARNESS] Navigating Steam to ${section.toUpperCase()} (${steamUri})`
    });

    window.location.href = steamUri;
    return {
      success: true,
      section,
      protocol: steamUri
    };
  }

  /**
   * Resolves a game name to an AppID without launching it.
   * Priority: 1) Real Steam library (fuzzy)  2) Hardcoded dict
   * Returns { appId, name, source } or null.
   */
  async resolveGame(gameQuery, alternatives = [], { skipLlmFallback = false } = {}) {
    const cleanQuery = gameQuery.trim().toLowerCase();

    if (this.steamLibrary && this.steamLibrary.isConfigured()) {
      if (!this.steamLibrary.library.length) {
        await this.steamLibrary.fetchLibrary();
      }
      let libMatch = this.steamLibrary.findGame(gameQuery);
      if (!libMatch && !skipLlmFallback) {
        libMatch = await resolveWithLlmFallback({
          query: gameQuery,
          alternatives,
          candidates: this.steamLibrary.library,
          kind: 'Steam game to launch',
          resolveEntity: this.resolveEntity,
          onLog: this.onLog
        });
      }
      if (libMatch) {
        return { appId: libMatch.appid, name: libMatch.name, source: 'steam_library' };
      }
    }

    let matchedGame = this.gameDatabase[cleanQuery];
    if (!matchedGame) {
      for (const [key, game] of Object.entries(this.gameDatabase)) {
        if (cleanQuery.includes(key) || key.includes(cleanQuery)) {
          matchedGame = game;
          break;
        }
      }
    }
    if (matchedGame) {
      return { appId: matchedGame.id, name: matchedGame.name, source: 'dict' };
    }

    return null;
  }

  /**
   * Resolves a game name to an AppID and launches via steam://run/<id>.
   * Falls back to a Steam Store search if resolveGame() finds nothing.
   */
  async launchGame(gameQuery, alternatives = [], options = {}) {
    const resolved = await this.resolveGame(gameQuery, alternatives, options);
    if (resolved) {
      const steamRunUri = `steam://run/${resolved.appId}`;
      this.onLog({ type: 'HARNESS', message: `[STEAM ${resolved.source === 'steam_library' ? 'LIBRARY MATCH' : 'DICT MATCH'}] ${resolved.name} (AppID: ${resolved.appId})` });
      this.onLog({ type: 'SUCCESS', message: `[GAME LAUNCH PROTOCOL] Executing: ${steamRunUri}` });
      window.location.href = steamRunUri;
      return {
        success: true,
        gameName: resolved.name,
        appId: resolved.appId,
        source: resolved.source,
        protocol: steamRunUri,
        message: resolved.source === 'steam_library' ? `Launching ${resolved.name}, Sir.` : `Launching ${resolved.name} on Steam, Sir.`
      };
    }

    const storeSearchUrl = `https://store.steampowered.com/search/?term=${encodeURIComponent(gameQuery)}`;
    this.onLog({ type: 'WARNING', message: `[STEAM HARNESS] "${gameQuery}" not found. Opening Steam Store search.` });
    window.open(storeSearchUrl, '_blank', 'noopener,noreferrer');
    return {
      success: false,
      gameName: gameQuery,
      storeUrl: storeSearchUrl,
      message: `I could not find "${gameQuery}" in your library, Sir. I've opened the Steam Store search for you.`
    };
  }

  /**
   * Returns list of supported pre-cached games for UI display.
   * If the real Steam library is loaded, returns most-played games from it instead.
   */
  getFeaturedGames() {
    if (this.steamLibrary && this.steamLibrary.library.length > 0) {
      return this.steamLibrary.getTopGames(6).map(g => ({
        name: g.name,
        id: g.appid,
        icon: '🎮',
        genre: `${Math.round(g.playtimeForever / 60)}h played`
      }));
    }
    return [
      { name: "Counter-Strike 2", id: "730", icon: "🔫", genre: "FPS" },
      { name: "Dota 2", id: "570", icon: "⚔️", genre: "MOBA" },
      { name: "Cyberpunk 2077", id: "1091500", icon: "🤖", genre: "RPG" },
      { name: "Elden Ring", id: "1245620", icon: "🗡️", genre: "Action" },
      { name: "GTA V", id: "271590", icon: "🚗", genre: "Action" },
      { name: "HELLDIVERS 2", id: "553850", icon: "💣", genre: "Co-Op" }
    ];
  }
}

