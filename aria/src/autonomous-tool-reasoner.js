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
   *    toolName: 'GOOGLE_SEARCH' | 'STEAM_LAUNCH_GAME' | 'STEAM_OPEN_CLIENT' | 'SPOTIFY_PLAY_SONG' | 'SPOTIFY_PLAY_LIBRARY' | 'SPOTIFY_OPEN_CLIENT' | 'EPIC_OPEN_CLIENT' | 'XBOX_OPEN_CLIENT' | 'XBOX_LAUNCH_GAME' | 'EPIC_LAUNCH_GAME' | 'OPEN_SITE' | 'MATH_QUERY' | 'SET_MODEL_TIER' | 'SCREEN_MONITOR_START' | 'SCREEN_MONITOR_STOP' | 'SCREEN_QUERY' | 'CAMERA_START' | 'CAMERA_STOP' | 'CAMERA_QUERY' | 'GMAIL_CHECK_INBOX' | 'GMAIL_SEARCH' | 'GMAIL_READ_MESSAGE' | 'CALENDAR_LIST_UPCOMING' | 'CALENDAR_SEARCH' | 'CALENDAR_CREATE_EVENT' | 'CONVERSATIONAL',
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

    // 8g. Check for screen overlay toggle commands
    if (text.match(/^(?:show|hide|toggle)\s+(?:(?:the|screen)\s+)?overlay[.!]?\s*$/i)) {
      return {
        shouldCallTool: true,
        toolName: 'SCREEN_TOGGLE_OVERLAY',
        confidence: 0.93,
        params: {},
        reasoning: "Autonomous reasoner detected intent to toggle the screen overlay."
      };
    }

    // 1g. Check for camera vision commands — same thin fallback-net role as
    // the screen monitoring checks above.
    if (text.match(/^(?:open|start|turn\s+on)\s+(?:the\s+|my\s+)?camera[.!]?\s*$/i)) {
      return {
        shouldCallTool: true,
        toolName: 'CAMERA_START',
        confidence: 0.93,
        params: {},
        reasoning: "Autonomous reasoner detected intent to open the camera vision feed."
      };
    }

    if (text.match(/^(?:close|stop|turn\s+off)\s+(?:the\s+|my\s+)?camera[.!]?\s*$/i)) {
      return {
        shouldCallTool: true,
        toolName: 'CAMERA_STOP',
        confidence: 0.93,
        params: {},
        reasoning: "Autonomous reasoner detected intent to close the camera vision feed."
      };
    }

    const cameraQueryPattern = /what am i holding|how many fingers|what('?s| is) (?:in front of|on) (?:the |my )?camera|what do you see(?: in the camera)?|look at (?:the |my )?camera|can you see me|what am i wearing|what color (?:is this|am i)/i;
    if (cameraQueryPattern.test(text)) {
      return {
        shouldCallTool: true,
        toolName: 'CAMERA_QUERY',
        confidence: 0.85,
        params: { question: input.trim() },
        reasoning: "Autonomous reasoner detected a question about what's visible through the camera."
      };
    }

    // 1h. Check for Gmail commands — same thin fallback-net role as the
    // screen/camera checks above. Checked well before the "gmail" entry in
    // the OPEN_SITE site map (section 2) so "check my email" is never
    // misread as "open gmail.com"; plain "open gmail" still falls through to
    // that site-map entry unchanged, since none of these require "open".
    if (text.match(/^(?:check|any new)\s+(?:my\s+)?(?:emails?|gmail|inbox)[.!]?\s*$/i)) {
      return {
        shouldCallTool: true,
        toolName: 'GMAIL_CHECK_INBOX',
        confidence: 0.93,
        params: {},
        reasoning: "Autonomous reasoner detected intent to check the Gmail inbox."
      };
    }

    const gmailSearchMatch = text.match(/(?:search|find)\s+(?:my\s+)?(?:emails?|gmail|inbox)\s+for\s+(.+)/i);
    if (gmailSearchMatch && gmailSearchMatch[1]) {
      return {
        shouldCallTool: true,
        toolName: 'GMAIL_SEARCH',
        confidence: 0.9,
        params: { query: gmailSearchMatch[1].trim() },
        reasoning: `Autonomous reasoner detected intent to search Gmail for "${gmailSearchMatch[1].trim()}".`
      };
    }

    const gmailReadMatch = text.match(/read\s+(?:me\s+)?(?:the\s+)?(?:email|message)\s+from\s+(.+)/i);
    if (gmailReadMatch && gmailReadMatch[1]) {
      return {
        shouldCallTool: true,
        toolName: 'GMAIL_READ_MESSAGE',
        confidence: 0.88,
        params: { query: gmailReadMatch[1].trim() },
        reasoning: `Autonomous reasoner detected intent to read the email from "${gmailReadMatch[1].trim()}".`
      };
    }

    // 1i. Check for Google Calendar commands — same thin fallback-net role as
    // the Gmail/screen/camera checks above. The create-event path only
    // extracts the raw title + when-phrase; the harness owns turning "when"
    // into an actual timestamp via chrono-node (see Operations in
    // docs/superpowers/specs/2026-08-15-google-calendar-harness-design.md).
    if (text.match(/^(?:what'?s|what is|check|show)\s+(?:on\s+)?(?:my\s+)?(?:calendar|schedule)[.!]?\s*$/i)
      || text.match(/(?:any|do i have|are there)\s+(?:(?:any|some|upcoming)\s+)?(?:events?|meetings?)(?:\s+(?:today|this week|coming up|tomorrow))?[.!]?\s*$/i)) {
      return {
        shouldCallTool: true,
        toolName: 'CALENDAR_LIST_UPCOMING',
        confidence: 0.93,
        params: {},
        reasoning: "Autonomous reasoner detected intent to check the user's upcoming calendar events."
      };
    }

    const calendarSearchMatch = text.match(/(?:search|find|look\s+up)\s+(?:my\s+)?(?:calendar|schedule)\s+for\s+(.+)/i)
      || text.match(/find\s+(?:the\s+)?(?:meeting|event|appointment)\s+(?:about|for)\s+(.+)/i);
    if (calendarSearchMatch && calendarSearchMatch[1]) {
      return {
        shouldCallTool: true,
        toolName: 'CALENDAR_SEARCH',
        confidence: 0.9,
        params: { query: calendarSearchMatch[1].trim() },
        reasoning: `Autonomous reasoner detected intent to search the calendar for "${calendarSearchMatch[1].trim()}".`
      };
    }

    const calendarCreateTriggerMatch = text.match(/(?:schedule|create|add|set\s+up|book|make)\s+(?:an?\s+)?(?:event|meeting|appointment|reminder)\b/i);
    if (calendarCreateTriggerMatch) {
      // Quoted-title heuristic: a quoted phrase is an unambiguous title
      // regardless of word order ("make a reminder for the 19th at 8am for
      // "school starting"" vs "schedule a meeting called "standup" for
      // tomorrow at 9am") — natural speech puts the title before or after
      // the when-phrase inconsistently, but a quote always marks the title.
      const quotedTitleMatch = text.match(/["“]([^"”]+)["”]/);
      if (quotedTitleMatch) {
        const title = quotedTitleMatch[1].trim();
        const triggerEnd = calendarCreateTriggerMatch.index + calendarCreateTriggerMatch[0].length;
        let whenText = text.slice(triggerEnd).replace(quotedTitleMatch[0], '').trim();
        // Strip connector words from both ends repeatedly — phrasing like
        // "called <quoted title> for X" or "for X for <quoted title>" can
        // leave more than one leading/trailing connector after the title is
        // removed (e.g. "called" then "for").
        let prevWhenText;
        do {
          prevWhenText = whenText;
          whenText = whenText.replace(/^(?:called|named|titled|for|at|on)\s+/i, '').trim();
          whenText = whenText.replace(/\s+(?:for|at|on)$/i, '').trim();
        } while (whenText !== prevWhenText);
        if (title && whenText) {
          return {
            shouldCallTool: true,
            toolName: 'CALENDAR_CREATE_EVENT',
            confidence: 0.9,
            params: { title, when: whenText },
            reasoning: `Autonomous reasoner detected intent to schedule "${title}" for "${whenText}" (quoted-title heuristic).`
          };
        }
      }

      // Fallback: unquoted "called/named/titled X at/on/for Y" (title-then-when).
      const calendarCreateMatch = text.match(/(?:called|named|titled)\s+(.+?)\s+(?:at|on|for)\s+(.+)/i);
      if (calendarCreateMatch && calendarCreateMatch[1] && calendarCreateMatch[2]) {
        return {
          shouldCallTool: true,
          toolName: 'CALENDAR_CREATE_EVENT',
          confidence: 0.85,
          params: { title: calendarCreateMatch[1].trim(), when: calendarCreateMatch[2].trim() },
          reasoning: `Autonomous reasoner detected intent to schedule event "${calendarCreateMatch[1].trim()}" for "${calendarCreateMatch[2].trim()}".`
        };
      }
    }

    // 1x. Web browser / new-tab intents — checked before the broad gaming
    // "open <anything>" fallback (section 3b) so vague browsing commands never
    // get routed to Steam ("open my browser" -> launch game "my browser").
    // A bare "open my browser" / "open a tab" opens the browser itself;
    // "open a new tab with/for/about <topic>" is a web search for that topic.
    const bareBrowser = text.match(/^(?:open|start|launch)\s+(?:(?:my|the|a|your|our)\s+)?(?:web\s+)?browser[.!]?\s*$/i);
    const newTabOpen = text.match(/^(?:open|start)\s+(?:a\s+)?new\s+tab[.!]?\s*$/i);
    const tabOpen = text.match(/^(?:open|start)\s+a\s+tab[.!]?\s*$/i);
    const tabTopic = text.match(/^(?:open|start)\s+(?:a\s+)?new\s+tab\s+(?:with|about|for|on)\s+(.+)$/i);
    if (bareBrowser || newTabOpen || tabOpen) {
      return {
        shouldCallTool: true,
        toolName: 'OPEN_SITE',
        confidence: 0.95,
        params: { siteName: 'browser' },
        reasoning: "Autonomous reasoner identified intent to open the user's web browser."
      };
    }
    if (tabTopic) {
      return {
        shouldCallTool: true,
        toolName: 'GOOGLE_SEARCH',
        confidence: 0.9,
        params: { query: tabTopic[1].trim() },
        reasoning: `Autonomous reasoner identified intent to open a new tab and search for "${tabTopic[1].trim()}".`
      };
    }

    // 2. Direct Website Intent — checked BEFORE the gaming sections below so
    // "open google maps/docs/drive/photos/calendar" or "open my gmail" hit
    // this site map instead of being swallowed by the broad launch fallback
    // as a bogus Steam game ("google maps", "my gmail") or hijacked by a
    // gaming keyword. 'google' sits last so specific Google properties
    // ("open google maps" -> maps) win over the generic homepage.
    const siteMap = ['youtube', 'github', 'reddit', 'twitter', 'wikipedia', 'amazon', 'gmail', 'maps', 'google'];
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

    // 3. Check for gaming & Steam launch intents (implicit & explicit)
    const gamingKeywords = ['play', 'game', 'gaming', 'steam', 'csgo', 'cs2', 'dota', 'cyberpunk', 'elden ring', 'gta', 'apex', 'tf2', 'helldivers', 'pubg', 'rust', 'baldurs gate'];
    const gamingIntentDetected = gamingKeywords.some(kw => text.includes(kw));

    // Actual launch intent — an informational question that merely CONTAINS
    // a game keyword ("what is rust", "how to learn rust", "what is elden
    // ring") is not a launch command and must fall through to the web-search
    // heuristics instead of hijacking STEAM_LAUNCH_GAME.
    const launchIntentPattern = /\b(?:launch|lunch|open|play|run|start|fire up|load up)\b/;

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
        if (launchIntentPattern.test(text) && game.keywords.some(kw => text.includes(kw))) {
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

    // 3b. Broad launch-verb fallback — covers "launch/start/run/open <any title>"
    // even when the sentence has no recognized gaming keyword (e.g. a game only
    // present in the user's real Steam library, like "launch Cookie Clicker").
    // Delegates the actual name resolution to SteamHarness (library -> dict -> store search).
    // "lunch" is included as an alias since speech-to-text frequently mishears "launch" as "lunch".
    // Open-site targets never reach here: the OPEN_SITE site-map check above runs first,
    // and nonGameTargets additionally guards multi-word Google-property phrases.
    const launchMatch = text.match(/(?:launch|lunch|start|run|open)\s+(?:the\s+game\s+|game\s+)?([a-z0-9][a-z0-9\s':\-]*)/i);
    if (launchMatch && launchMatch[1]) {
      const candidate = launchMatch[1].trim();
      const nonGameTargets = ['steam', 'google', 'youtube', 'browser', 'chrome', 'reddit', 'github', 'twitter', 'wikipedia', 'amazon', 'gmail', 'maps', 'epic', 'epic games', 'xbox', 'google docs', 'google drive', 'google photos', 'google calendar', 'google maps', 'my gmail'];
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

    // 4. Check for a model-tier switch command ("switch mode to high",
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

    // 5. Check for math queries (arithmetic through high-level math) —
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

    // 6. Check for real-time Web Search / Info retrieval intents
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
