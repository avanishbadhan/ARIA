/**
 * Autonomous Tool Calling & Reasoning Engine for JARVIS
 * Analyzes natural language input contextually and determines when to trigger
 * Google Search, Steam Game Launcher, Web Navigation, or System Utilities autonomously.
 */

import { normalizeTierAlias } from './model-tiers.js';

export class AutonomousToolReasoner {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  /**
   * Evaluates user input and returns tool calling decisions.
   * Format returned:
   * {
   *    shouldCallTool: true|false,
   *    toolName: 'GOOGLE_SEARCH' | 'STEAM_LAUNCH_GAME' | 'STEAM_OPEN_CLIENT' | 'SPOTIFY_PLAY_SONG' | 'SPOTIFY_PLAY_LIBRARY' | 'SPOTIFY_OPEN_CLIENT' | 'EPIC_OPEN_CLIENT' | 'XBOX_OPEN_CLIENT' | 'XBOX_LAUNCH_GAME' | 'EPIC_LAUNCH_GAME' | 'OPEN_SITE' | 'MATH_QUERY' | 'SET_MODEL_TIER' | 'SCREEN_MONITOR_START' | 'SCREEN_MONITOR_STOP' | 'SCREEN_QUERY' | 'CONVERSATIONAL',
   *    confidence: 0.0 to 1.0,
   *    params: { ... },
   *    reasoning: "Explanation of autonomous decision"
   * }
   */
  evaluateIntent(input) {
    if (!input || !input.trim()) {
      return { shouldCallTool: false, toolName: 'CONVERSATIONAL', confidence: 1.0 };
    }

    const text = input.trim().toLowerCase();

    // 1. Check for Spotify commands — requires the literal word "spotify",
    // so it never competes with the bare "play X" -> Steam game-launch
    // fallback below (Steam is the default for "play"; Spotify must say so).
    // Checked before the gaming section since it's an unambiguous, explicit
    // trigger rather than a heuristic guess.
    if (text.includes('spotify')) {
      // Library-context keywords (playlist/album/liked songs) take priority
      // over a plain track search even when "spotify" is explicitly said
      // ("play the chill playlist from spotify" must resolve against the
      // user's real playlists, not a track-name search for "the chill
      // playlist"). Mirrors the unconditional matching in 1b below.
      const likedInSpotify = text.match(/play\s+(?:my\s+)?(?:liked|saved)\s+songs?\b/i);
      if (likedInSpotify) {
        return {
          shouldCallTool: true,
          toolName: 'SPOTIFY_PLAY_LIBRARY',
          confidence: 0.93,
          params: { kind: 'liked', query: '' },
          reasoning: "Autonomous reasoner detected intent to play the user's Liked Songs on Spotify."
        };
      }

      const playlistInSpotify = text.match(/play\s+(?:the\s+|my\s+)?playlist\s+(.+)/i)
        || text.match(/play\s+(?:my\s+)?(.+?)\s+playlist\b/i);
      if (playlistInSpotify && playlistInSpotify[1]) {
        // Strip a trailing "... from/on/in/via spotify" phrase, and strip
        // the bare word "spotify" itself if it landed inside the capture
        // (e.g. "play my spotify playlist" has no real playlist name — just
        // "spotify" sitting between "my" and "playlist" as filler).
        const playlistName = playlistInSpotify[1]
          .replace(/\s*(?:on|in|via|from)\s+spotify\s*$/i, '')
          .replace(/\bspotify\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          shouldCallTool: true,
          toolName: 'SPOTIFY_PLAY_LIBRARY',
          confidence: 0.9,
          params: { kind: 'playlist', query: playlistName },
          reasoning: `Autonomous reasoner detected intent to play playlist "${playlistName}" from the user's Spotify library.`
        };
      }

      const albumInSpotify = text.match(/play\s+(?:the\s+|my\s+)?album\s+(.+)/i)
        || text.match(/play\s+(?:my\s+)?(.+?)\s+album\b/i);
      if (albumInSpotify && albumInSpotify[1]) {
        const albumName = albumInSpotify[1]
          .replace(/\s*(?:on|in|via|from)\s+spotify\s*$/i, '')
          .replace(/\bspotify\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          shouldCallTool: true,
          toolName: 'SPOTIFY_PLAY_LIBRARY',
          confidence: 0.9,
          params: { kind: 'album', query: albumName },
          reasoning: `Autonomous reasoner detected intent to play album "${albumName}" from the user's Spotify library.`
        };
      }

      // "on/in/via/from spotify" — covers all the natural prepositions
      // people actually say ("from spotify" was previously missing here,
      // which let phrases like "play <album> from spotify" fall all the way
      // through to the Steam gaming fallback below and launch Steam instead).
      const playOnSpotify = text.match(/play\s+(.+?)\s+(?:on|in|via|from)\s+spotify\b/i)
        || text.match(/spotify\s+play\s+(.+)/i);

      if (playOnSpotify && playOnSpotify[1]) {
        return {
          shouldCallTool: true,
          toolName: 'SPOTIFY_PLAY_SONG',
          confidence: 0.93,
          params: { query: playOnSpotify[1].trim() },
          reasoning: `Autonomous reasoner detected intent to play "${playOnSpotify[1].trim()}" via Spotify.`
        };
      }

      if (text.includes('open') || text.includes('launch') || text.includes('lunch') || text.includes('start') || text === 'spotify') {
        return {
          shouldCallTool: true,
          toolName: 'SPOTIFY_OPEN_CLIENT',
          confidence: 0.93,
          params: {},
          reasoning: "Autonomous reasoner identified intent to open the Spotify application."
        };
      }

      // Safety net: any phrase that mentions "spotify" alongside a "play"
      // verb but didn't match a pattern above (unusual phrasing, STT
      // artifacts, etc.) must still resolve to Spotify, never fall through
      // to the Steam section below and get misread as a game title.
      const genericPlay = text.match(/play\s+(.+)/i);
      if (genericPlay && genericPlay[1]) {
        const query = genericPlay[1].replace(/\s*(?:on|in|via|from)?\s*spotify\s*$/i, '').trim();
        if (query) {
          return {
            shouldCallTool: true,
            toolName: 'SPOTIFY_PLAY_SONG',
            confidence: 0.85,
            params: { query },
            reasoning: `Autonomous reasoner detected intent to play "${query}" via Spotify (fallback phrasing match).`
          };
        }
      }
    }

    // 1b. Personal Spotify library context (playlist/album/liked songs).
    // Detected independently of the literal word "spotify" so natural
    // phrasing works ("play my chill playlist"), and checked before the
    // Steam gaming section below since bare "play" is a Steam trigger there.
    // These keywords (playlist/album/liked songs) are unambiguous to
    // Spotify, so there's no risk of colliding with a game-title guess.
    const likedSongsMatch = text.match(/play\s+(?:my\s+)?(?:liked|saved)\s+songs?\b/i);
    if (likedSongsMatch) {
      return {
        shouldCallTool: true,
        toolName: 'SPOTIFY_PLAY_LIBRARY',
        confidence: 0.93,
        params: { kind: 'liked', query: '' },
        reasoning: "Autonomous reasoner detected intent to play the user's Liked Songs on Spotify."
      };
    }

    const playlistMatch = text.match(/play\s+(?:the\s+|my\s+)?playlist\s+(.+)/i)
      || text.match(/play\s+(?:my\s+)?(.+?)\s+playlist\b/i);
    if (playlistMatch && playlistMatch[1]) {
      const playlistName = playlistMatch[1].trim();
      return {
        shouldCallTool: true,
        toolName: 'SPOTIFY_PLAY_LIBRARY',
        confidence: 0.9,
        params: { kind: 'playlist', query: playlistName },
        reasoning: `Autonomous reasoner detected intent to play playlist "${playlistName}" from the user's Spotify library.`
      };
    }

    const albumMatch = text.match(/play\s+(?:the\s+|my\s+)?album\s+(.+)/i)
      || text.match(/play\s+(?:my\s+)?(.+?)\s+album\b/i);
    if (albumMatch && albumMatch[1]) {
      const albumName = albumMatch[1].trim();
      return {
        shouldCallTool: true,
        toolName: 'SPOTIFY_PLAY_LIBRARY',
        confidence: 0.9,
        params: { kind: 'album', query: albumName },
        reasoning: `Autonomous reasoner detected intent to play album "${albumName}" from the user's Spotify library.`
      };
    }

    // 1c. Check for Epic Games Launcher commands — anchored to the whole
    // utterance (not a loose substring match) so real game titles or
    // phrases that merely contain "epic" ("launch Epic Mickey", "epic
    // quest") aren't misrouted here. Unlike "spotify" (which essentially
    // never appears inside an unrelated phrase), "epic" is common enough in
    // game titles/marketing language that a bare text.includes('epic')
    // check would misfire. The verb is optional so the bare word alone
    // ("epic", "epic games") also matches, and a trailing [.!]? tolerates
    // punctuation speech-to-text commonly appends ("Open Epic Games.").
    if (text.match(/^(?:(?:open|launch|lunch|start)\s+)?(?:the\s+)?epic(?:\s+games)?(?:\s+launcher)?[.!]?\s*$/i)) {
      return {
        shouldCallTool: true,
        toolName: 'EPIC_OPEN_CLIENT',
        confidence: 0.93,
        params: {},
        reasoning: "Autonomous reasoner identified intent to open the Epic Games Launcher."
      };
    }

    // 1d. Check for Xbox app commands — same anchored-match principle as
    // Epic above ("xbox" commonly appears in unrelated phrases like "the
    // new Xbox exclusive", so a loose substring check would misfire).
    if (text.match(/^(?:(?:open|launch|lunch|start)\s+)?(?:the\s+)?xbox(?:\s+app)?[.!]?\s*$/i)) {
      return {
        shouldCallTool: true,
        toolName: 'XBOX_OPEN_CLIENT',
        confidence: 0.93,
        params: {},
        reasoning: "Autonomous reasoner identified intent to open the Xbox App."
      };
    }

    // 1e. Check for explicit "launch <game> on xbox/epic" targeting — mirrors
    // Spotify's "play X on spotify" pattern. Trailing [.!]?\s*$ tolerates
    // STT punctuation (see 633afaf, which fixed the same class of bug for
    // the open-client intents above; applying the lesson here proactively).
    const playOnXbox = text.match(/(?:launch|play|start)\s+(.+?)\s+(?:on|in|via|from)\s+xbox\b[.!]?\s*$/i);
    if (playOnXbox && playOnXbox[1]) {
      return {
        shouldCallTool: true,
        toolName: 'XBOX_LAUNCH_GAME',
        confidence: 0.9,
        params: { gameQuery: playOnXbox[1].trim() },
        reasoning: `Autonomous reasoner detected intent to launch "${playOnXbox[1].trim()}" via Xbox.`
      };
    }

    const playOnEpic = text.match(/(?:launch|play|start)\s+(.+?)\s+(?:on|in|via|from)\s+epic(?:\s+games)?\b[.!]?\s*$/i);
    if (playOnEpic && playOnEpic[1]) {
      return {
        shouldCallTool: true,
        toolName: 'EPIC_LAUNCH_GAME',
        confidence: 0.9,
        params: { gameQuery: playOnEpic[1].trim() },
        reasoning: `Autonomous reasoner detected intent to launch "${playOnEpic[1].trim()}" via Epic Games.`
      };
    }

    // 1f. Check for screen monitoring/vision commands — a thin fallback net
    // for when the AI-first classifier is unavailable (see ai-intent-classifier.js);
    // doesn't need exhaustive phrasing coverage since AI handles the bulk of it.
    if (text.match(/^(?:start|begin)\s+(?:monitoring|watching)\s+(?:my\s+|the\s+)?screen[.!]?\s*$/i)) {
      return {
        shouldCallTool: true,
        toolName: 'SCREEN_MONITOR_START',
        confidence: 0.93,
        params: {},
        reasoning: "Autonomous reasoner detected intent to arm screen monitoring."
      };
    }

    if (text.match(/^(?:stop|end)\s+(?:monitoring|watching)\s+(?:my\s+|the\s+)?screen[.!]?\s*$/i)) {
      return {
        shouldCallTool: true,
        toolName: 'SCREEN_MONITOR_STOP',
        confidence: 0.93,
        params: {},
        reasoning: "Autonomous reasoner detected intent to disarm screen monitoring."
      };
    }

    const screenQueryPattern = /what'?s on my screen|what is on my screen|what does (?:this|that) say|read (?:this|that)|what am i looking at|describe my screen|look at my screen|can you see my screen/i;
    if (screenQueryPattern.test(text)) {
      return {
        shouldCallTool: true,
        toolName: 'SCREEN_QUERY',
        confidence: 0.85,
        params: { question: input.trim() },
        reasoning: "Autonomous reasoner detected a question about the contents of the screen."
      };
    }

    // 2. Check for gaming & Steam launch intents (implicit & explicit)
    const gamingKeywords = ['play', 'game', 'gaming', 'steam', 'csgo', 'cs2', 'dota', 'cyberpunk', 'elden ring', 'gta', 'apex', 'tf2', 'helldivers', 'pubg', 'rust', 'baldurs gate'];
    const gamingIntentDetected = gamingKeywords.some(kw => text.includes(kw));

    if (gamingIntentDetected) {
      // "lunch" is a common speech-to-text mishearing of "launch" — treat it as an alias.
      if (text.includes('steam') && (text.includes('open') || text.includes('launch') || text.includes('lunch') || text.includes('start'))) {
        return {
          shouldCallTool: true,
          toolName: 'STEAM_OPEN_CLIENT',
          confidence: 0.95,
          params: {},
          reasoning: "Autonomous reasoner identified intent to launch Steam client application."
        };
      }

      // Detect game titles inside phrase
      const gameMatches = [
        { name: "Counter-Strike 2", keywords: ["counter strike", "csgo", "cs2", "counter-strike"] },
        { name: "Dota 2", keywords: ["dota 2", "dota"] },
        { name: "Cyberpunk 2077", keywords: ["cyberpunk 2077", "cyberpunk"] },
        { name: "Elden Ring", keywords: ["elden ring"] },
        { name: "Grand Theft Auto V", keywords: ["gta v", "gta 5", "gta", "grand theft auto"] },
        { name: "Apex Legends", keywords: ["apex legends", "apex"] },
        { name: "Team Fortress 2", keywords: ["tf2", "team fortress"] },
        { name: "Baldur's Gate 3", keywords: ["baldur's gate", "baldurs gate"] },
        { name: "HELLDIVERS 2", keywords: ["helldivers 2", "helldivers"] },
        { name: "PUBG: BATTLEGROUNDS", keywords: ["pubg"] },
        { name: "Rust", keywords: ["rust"] }
      ];

      for (const game of gameMatches) {
        if (game.keywords.some(kw => text.includes(kw))) {
          return {
            shouldCallTool: true,
            toolName: 'STEAM_LAUNCH_GAME',
            confidence: 0.92,
            params: { gameQuery: game.name },
            reasoning: `Autonomous reasoner detected intent to launch game "${game.name}" via Steam Harness.`
          };
        }
      }

      // Generic play request
      const playMatch = text.match(/(?:play|wanna play|want to play|fire up|load up)\s+([a-z0-9\s]+)/i);
      if (playMatch && playMatch[1]) {
        return {
          shouldCallTool: true,
          toolName: 'STEAM_LAUNCH_GAME',
          confidence: 0.85,
          params: { gameQuery: playMatch[1].trim() },
          reasoning: `Autonomous reasoner inferred game launch request for "${playMatch[1].trim()}".`
        };
      }
    }

    // 2b. Broad launch-verb fallback — covers "launch/start/run/open <any title>"
    // even when the sentence has no recognized gaming keyword (e.g. a game only
    // present in the user's real Steam library, like "launch Cookie Clicker").
    // Delegates the actual name resolution to SteamHarness (library -> dict -> store search).
    // "lunch" is included as an alias since speech-to-text frequently mishears "launch" as "lunch".
    const launchMatch = text.match(/(?:launch|lunch|start|run|open)\s+(?:the\s+game\s+|game\s+)?([a-z0-9][a-z0-9\s':\-]*)/i);
    if (launchMatch && launchMatch[1]) {
      const candidate = launchMatch[1].trim();
      const nonGameTargets = ['steam', 'google', 'youtube', 'browser', 'chrome', 'reddit', 'github', 'twitter', 'wikipedia', 'amazon', 'gmail', 'maps', 'epic', 'epic games', 'xbox'];
      if (!nonGameTargets.includes(candidate)) {
        return {
          shouldCallTool: true,
          toolName: 'STEAM_LAUNCH_GAME',
          confidence: 0.75,
          params: { gameQuery: candidate },
          reasoning: `Autonomous reasoner inferred a game launch request for "${candidate}"; deferring to Steam Harness library resolution.`
        };
      }
    }

    // 3. Check for a model-tier switch command ("switch mode to high",
    // "set mode to max") — checked early, before search/math, since it's an
    // explicit system command rather than something to look up or compute.
    const tierMatch = text.match(/\b(?:switch|set|change)\s+(?:mode|model|tier)\s+to\s+(\w+)\b/i)
      || text.match(/\bswitch\s+to\s+(\w+)\s+mode\b/i);

    if (tierMatch) {
      const tier = normalizeTierAlias(tierMatch[1]);
      if (tier) {
        return {
          shouldCallTool: true,
          toolName: 'SET_MODEL_TIER',
          confidence: 0.95,
          params: { tier },
          reasoning: `Autonomous reasoner detected a request to switch the active Groq model tier to "${tier}".`
        };
      }
      // Recognized phrasing but an unrecognized tier word (e.g. "switch
      // mode to insane") — fall through rather than guess.
    }

    // 4. Check for math queries (arithmetic through high-level math) —
    // checked before the web-search heuristics below, since e.g. "what is 5
    // plus 3" would otherwise match the "what is" search starter. Scoped
    // deliberately to math phrasing only, not a catch-all for trivia.
    const mathSymbolPattern = /\d\s*[+\-*/^]\s*\d|[√∫]/;
    const mathKeywordPattern = /\b(calculate|solve for|square root of|cube root of|derivative of|integral of|factorial of|log of|logarithm of)\b/;
    const mathPhrasePattern = /\b(plus|minus|times|multiplied by|divided by|to the power of|squared|cubed)\b/;
    const percentPattern = /\d+\s*%\s*of\s*\d+|\d+\s*percent\s*of\s*\d+/;

    const looksLikeMath =
      mathSymbolPattern.test(text) ||
      mathKeywordPattern.test(text) ||
      percentPattern.test(text) ||
      (mathPhrasePattern.test(text) && /\d/.test(text));

    if (looksLikeMath) {
      return {
        shouldCallTool: true,
        toolName: 'MATH_QUERY',
        confidence: 0.9,
        params: { query: input },
        reasoning: "Autonomous reasoner classified query as a math computation, routing to WolframAlpha for a grounded answer."
      };
    }

    // 5. Check for real-time Web Search / Info retrieval intents
    const searchStarters = [
      'what is', 'what are', 'who is', 'who was', 'where is', 'where are',
      'how to', 'how does', 'why is', 'why do', 'tell me about', 'find out',
      'look up', 'search', 'news on', 'weather in', 'latest info', 'score of'
    ];

    const isInformationalQuery = searchStarters.some(starter => text.startsWith(starter) || text.includes(starter));
    const specifiesGoogle = text.includes('google') || text.includes('search');

    if (specifiesGoogle || isInformationalQuery) {
      let query = input;
      // Clean up prefix if needed
      searchStarters.forEach(s => {
        if (query.toLowerCase().startsWith(s)) {
          // Keep intact for full context search
        }
      });

      return {
        shouldCallTool: true,
        toolName: 'GOOGLE_SEARCH',
        confidence: isInformationalQuery ? 0.88 : 0.95,
        params: { query: query },
        reasoning: "Autonomous reasoner classified query as requiring real-time web knowledge lookup via Google Harness."
      };
    }

    // 6. Direct Website Intent
    const siteMap = ['youtube', 'github', 'reddit', 'twitter', 'wikipedia', 'amazon', 'gmail', 'maps'];
    for (const site of siteMap) {
      if (text.includes(site) && (text.includes('open') || text.includes('go to') || text.includes('show'))) {
        return {
          shouldCallTool: true,
          toolName: 'OPEN_SITE',
          confidence: 0.94,
          params: { siteName: site },
          reasoning: `Autonomous reasoner identified direct web navigation intent for site "${site}".`
        };
      }
    }

    // 7. Default Conversational / System query
    return {
      shouldCallTool: false,
      toolName: 'CONVERSATIONAL',
      confidence: 0.90,
      params: { text: input },
      reasoning: "Input processed as internal conversational query."
    };
  }
}
