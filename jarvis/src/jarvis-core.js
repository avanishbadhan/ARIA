/**
 * JARVIS Core AI Brain & Multi-Agent Swarm Orchestrator
 * Coordinates voice interaction, OpenRouter LLM intelligence, autonomous tool decision engine,
 * Google Search browser harness, Steam game launcher harness, Spotify harness, and swarm telemetry.
 */

import { SteamHarness } from './steam-harness.js';
import { SpotifyHarness } from './spotify-harness.js';
import { EpicGamesHarness } from './epic-games-harness.js';
import { XboxHarness } from './xbox-harness.js';
import { EpicGamesLibrary } from './epic-games-library.js';
import { XboxLibrary } from './xbox-library.js';
import { GameLauncherOrchestrator } from './game-launcher-orchestrator.js';
import { AutonomousToolReasoner } from './autonomous-tool-reasoner.js';
import { OpenRouterClient } from './openrouter-client.js';
import { GroqClient } from './groq-client.js';
import { GeminiClient } from './gemini-client.js';
import { WolframClient } from './wolfram-client.js';
import { MODEL_TIERS } from './model-tiers.js';
import { loadSettings, saveSettings } from './settings.js';
import { classifyIntentWithAI, INTENT_CLASSIFIER_SYSTEM_PROMPT } from './ai-intent-classifier.js';
import { ScreenVisionHarness } from './screen-vision-harness.js';
import { GROUNDING_TOOLS, createToolExecutor } from './jarvis-tools.js';
import { GoogleAccountConnector } from './google-account-connector.js';
import { GmailHarness } from './gmail-harness.js';
import { GoogleCalendarHarness } from './google-calendar-harness.js';
import { LocationHarness } from './location-harness.js';
import { WeatherHarness } from './weather-harness.js';
import { McpWebHarness } from './mcp-web-harness.js';

// Only questions that reference the actual screen/display are treated as
// screen-vision (SCREEN_QUERY) questions. Anything else tagged SCREEN_QUERY
// by the AI classifier is re-routed to web search — see processUserInput.
const SCREEN_QUERY_PATTERN = /screen|display|monitor|screenshot|desktop|window|browser|page|tab|what am i looking at|what do(?:es)? (?:this|that) say|what'?s on (?:my|the) screen|describe (?:my|the) screen/i;

export class JarvisCore {
  constructor(voiceEngine, harness, options = {}) {
    this.voiceEngine = voiceEngine;
    this.harness = harness;
    this.onLog = options.onLog || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onResponse = options.onResponse || (() => {});
    this.onSwarmUpdate = options.onSwarmUpdate || (() => {});

    // Instantiate OpenRouter Client (key set via the Settings UI, stored in localStorage)
    const openRouterApiKey = localStorage.getItem('jarvis_openrouter_api_key') || '';

    // Instantiate Groq Client (optional — faster alternative to OpenRouter,
    // and a full substitute for it: see _chatWithActiveLLM)
    const groqApiKey = localStorage.getItem('jarvis_groq_api_key') || '';

    // OpenRouter is only "required" in the sense that at least one of the
    // two LLM providers needs a key — Groq alone is a fully valid setup.
    if (!openRouterApiKey && !groqApiKey) {
      this.onLog({ type: 'WARNING', message: '[LLM] No OpenRouter or Groq API key configured. Conversational responses will use local knowledge-base fallback only.' });
    }

    this.openRouter = new OpenRouterClient(openRouterApiKey, {
      onLog: (logData) => this.onLog(logData)
    });
    this.groq = new GroqClient(groqApiKey, {
      onLog: (logData) => this.onLog(logData)
    });
    this.groq.setTier(loadSettings().groqModelTier);

    // Instantiate Gemini Client — powers the Ultra tier exclusively (see
    // model-tiers.js). Unlike Groq/OpenRouter it isn't a general-purpose
    // alternate provider for the other tiers, so it has no setTier of its
    // own; _chatWithActiveLLM only reaches it when this.groq.currentTier
    // is 'ultra'.
    const geminiApiKey = localStorage.getItem('jarvis_gemini_api_key') || '';
    this.gemini = new GeminiClient(geminiApiKey, {
      onLog: (logData) => this.onLog(logData)
    });

    // Hermes (Nous Research) — same OpenRouter connection/key as
    // this.openRouter, just a different pinned model queue. NOT part of the
    // free pool (see docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md)
    // — only ever tried when useHermes is explicitly switched on, and every
    // call spends OpenRouter credits. Hermes 4 405B first (best tool-use),
    // Hermes 4 70B (cheaper, same family) as fallback.
    this.hermes = new OpenRouterClient(openRouterApiKey, {
      onLog: (logData) => this.onLog(logData),
      modelQueue: ['nousresearch/hermes-4-405b', 'nousresearch/hermes-4-70b']
    });

    // Instantiate WolframAlpha Client (optional — grounds math answers in a
    // real computation instead of the LLM guessing; no key means MATH_QUERY
    // just falls through to the normal LLM chat path)
    const wolframAppId = localStorage.getItem('jarvis_wolfram_app_id') || '';

    this.wolfram = new WolframClient(wolframAppId, {
      onLog: (logData) => this.onLog(logData)
    });

    // Google account credentials are optional — without them connected,
    // GmailHarness methods return a "connect your account in Settings"
    // message instead of hitting the network. Instantiated before
    // toolExecutor below since it captures this.gmailHarness by value. See
    // docs/superpowers/specs/2026-08-15-gmail-google-connector-design.md.
    this.googleClientId = localStorage.getItem('jarvis_google_client_id') || '';
    this.googleClientSecret = localStorage.getItem('jarvis_google_client_secret') || '';

    this.googleAccountConnector = new GoogleAccountConnector({
      onLog: (logData) => this.onLog(logData)
    });

    this.gmailHarness = new GmailHarness({
      onLog: (logData) => this.onLog(logData)
    });

    // Google Calendar Harness — same account as Gmail, no separate
    // connection step. Read-only list/search are grounding tools below;
    // createEvent stays off the grounding list (state-changing, same rule
    // that excludes Gmail send/draft) and is only reachable via explicit
    // intent. See
    // docs/superpowers/specs/2026-08-15-google-calendar-harness-design.md.
    this.calendarHarness = new GoogleCalendarHarness({
      onLog: (logData) => this.onLog(logData)
    });

    // Location Harness — resolves the user's current coordinates on demand
    // via navigator.geolocation (read-only, one-shot). Exposed as the
    // get_location grounding tool below so the LLM can answer location-aware
    // questions. Same no-IPC nature as the renderer's map panel.
    this.locationHarness = new LocationHarness({
      onLog: (logData) => this.onLog(logData)
    });

    // MCP Web Harness — real webpage reading via the Playwright MCP server
    // spawned in the Electron main process (electron/mcp-manager.cjs). No
    // credentials, no account connection. Exposed as the web_search
    // (upgraded from the old DuckDuckGo-only lookup) and browse_webpage
    // grounding tools below. See
    // docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md.
    this.mcpWebHarness = new McpWebHarness({
      onLog: (logData) => this.onLog(logData)
    });

    // Weather Harness — live conditions at a lat/lon via Open-Meteo, with the
    // actual request proxied through the Electron main process
    // (registerWeatherIpc in electron/main.cjs) so the renderer holds no
    // credentials and makes no CORS-prone call. Exposed as the get_weather
    // grounding tool; pair it with get_location for "weather here".
    this.weatherHarness = new WeatherHarness({
      onLog: (logData) => this.onLog(logData)
    });

    // Read-only grounding tools (WolframAlpha + web search + location +
    // weather + webpage browsing) exposed to autonomous LLM function-calling
    // for screen vision and general chat — see
    // docs/superpowers/specs/2026-08-14-grounding-tool-calling-design.md.
    // Action tools (game launch, Spotify, event creation, etc.) stay off this
    // list.
    this.groundingTools = GROUNDING_TOOLS;
    this.toolExecutor = createToolExecutor({
      wolfram: this.wolfram,
      harness: this.harness,
      gmail: this.gmailHarness,
      calendar: this.calendarHarness,
      location: this.locationHarness,
      weather: this.weatherHarness,
      mcpWeb: this.mcpWebHarness,
      getGoogleCredentials: () => ({ clientId: this.googleClientId, clientSecret: this.googleClientSecret }),
      onLog: (logData) => this.onLog(logData)
    });

    // Instantiate Steam Harness & Autonomous Tool Reasoner
    this.steamHarness = new SteamHarness({
      onLog: (logData) => this.onLog(logData),
      resolveEntity: (args) => this._resolveEntityWithLLM(args)
    });

    // Spotify credentials are optional — without them, playSong() falls back
    // to opening Spotify pre-searched instead of resolving+autoplaying the
    // exact track.
    this.spotifyClientId = localStorage.getItem('jarvis_spotify_client_id') || '';
    this.spotifyClientSecret = localStorage.getItem('jarvis_spotify_client_secret') || '';

    this.spotifyHarness = new SpotifyHarness({
      onLog: (logData) => this.onLog(logData),
      resolveEntity: (args) => this._resolveEntityWithLLM(args)
    });

    this.epicGamesLibrary = new EpicGamesLibrary({
      onLog: (logData) => this.onLog(logData)
    });

    this.xboxLibrary = new XboxLibrary({
      onLog: (logData) => this.onLog(logData)
    });

    this.epicGamesHarness = new EpicGamesHarness({
      onLog: (logData) => this.onLog(logData),
      epicGamesLibrary: this.epicGamesLibrary,
      resolveEntity: (args) => this._resolveEntityWithLLM(args)
    });

    this.xboxHarness = new XboxHarness({
      onLog: (logData) => this.onLog(logData),
      xboxLibrary: this.xboxLibrary,
      resolveEntity: (args) => this._resolveEntityWithLLM(args)
    });

    this.gameLauncherOrchestrator = new GameLauncherOrchestrator({
      steamHarness: this.steamHarness,
      xboxHarness: this.xboxHarness,
      epicGamesHarness: this.epicGamesHarness,
      xboxLibrary: this.xboxLibrary,
      epicGamesLibrary: this.epicGamesLibrary,
      onLog: (logData) => this.onLog(logData),
      resolveEntity: (args) => this._resolveEntityWithLLM(args)
    });

    this.toolReasoner = new AutonomousToolReasoner({
      onLog: (logData) => this.onLog(logData)
    });

    this.screenVisionHarness = new ScreenVisionHarness({
      onLog: (logData) => this.onLog(logData),
      askVisionLLM: (args) => this._askVisionLLM(args)
    });

    // Camera Vision Harness — unlike every other harness, this one owns real
    // DOM elements (video/canvas), so it's constructed by main.js (which
    // already holds those refs) and injected here rather than built
    // locally. May be null/undefined outside a browser context (tests).
    // askVisionLLM is wired here (not passed in from main.js) since it
    // needs `this`, which doesn't exist yet at the point main.js builds
    // the harness — same _askVisionLLM used by screenVisionHarness above,
    // just with source: 'camera' passed by CameraVisionHarness itself.
    this.cameraVisionHarness = options.cameraVisionHarness || null;
    if (this.cameraVisionHarness) {
      this.cameraVisionHarness.askVisionLLM = (args) => this._askVisionLLM(args);
    }

    // Short-term conversational memory: keeps the last few user/assistant turns
    // so follow-up questions ("what about its sequel?") resolve against prior context.
    this.conversationHistory = [];
    this.maxHistoryTurns = 8; // ~4 user/assistant pairs

    // Multi-Agent Swarm Registry
    this.swarmAgents = [
      { id: "agent-1", role: "Queen Coordinator", domain: "Orchestration", status: "ACTIVE", calls: 0, lastAction: "System Ready" },
      { id: "agent-2", role: "Voice Architect", domain: "Audio I/O", status: "ACTIVE", calls: 0, lastAction: "Voice Engine Standby" },
      { id: "agent-3", role: "Search Harness Lead", domain: "Browser Automation", status: "ACTIVE", calls: 0, lastAction: "Google Harness Primed" },
      { id: "agent-4", role: "Steam Automation Agent", domain: "Desktop Execution", status: "ACTIVE", calls: 0, lastAction: "Steam Protocol Ready" },
      { id: "agent-5", role: "Autonomous Tool Reasoner", domain: "Intent Reasoning", status: "ACTIVE", calls: 0, lastAction: "Proactive Classifier Active" },
      { id: "agent-6", role: "OpenRouter LLM Intelligence", domain: "Neural Brain", status: "ACTIVE", calls: 0, lastAction: "OpenRouter Connected" },
      { id: "agent-7", role: "Spotify Automation Agent", domain: "Desktop Execution", status: "ACTIVE", calls: 0, lastAction: "Spotify Protocol Ready" },
      { id: "agent-8", role: "Epic Games Automation Agent", domain: "Desktop Execution", status: "ACTIVE", calls: 0, lastAction: "Epic Games Protocol Ready" },
      { id: "agent-9", role: "Xbox Automation Agent", domain: "Desktop Execution", status: "ACTIVE", calls: 0, lastAction: "Xbox Protocol Ready" }
    ];

    // Local Conversational Knowledge Base Fallbacks
    this.knowledgeBase = {
      "who are you": "I am JARVIS, your Just A Rather Very Intelligent System. Powered by OpenRouter AI intelligence and multi-agent swarm architecture, I am equipped with voice synthesis, Google Search automation, desktop Steam and Spotify launchers, and autonomous tool calling capabilities.",
      "what can you do": "I can engage in live voice conversations using OpenRouter LLMs, answer your questions, autonomously perform Google searches, launch Steam, open and play games like Counter-Strike 2, Dota 2, or Cyberpunk 2077, open Spotify or play a specific song, open websites, and execute complex multi-agent tasks.",
      "hello": "Hello Sir. All systems are operational. OpenRouter network active. How may I assist you today?",
      "hi": "Greetings Sir. OpenRouter neural link connected. Ready for your voice or manual commands.",
      "status": "All core modules online. OpenRouter LLM active. Voice synthesis active. Speech recognition online. Google harness standby. Steam and Spotify protocol handlers ready. 7-agent swarm operational.",
      "steam": "Steam launcher harness is ready. I can open the Steam desktop client or launch any of your installed games directly.",
      "spotify": "Spotify harness is ready. I can open the Spotify desktop client, play a specific song if you say \"play <song> on spotify\", or, if your Spotify account is connected in Settings, play your own playlists and albums by name and your Liked Songs.",
      "gmail": "Gmail harness is ready. If your Google account is connected in Settings, I can check your inbox, search your email, or read a specific message by sender or subject.",
      "calendar": "Calendar harness is ready. If your Google account is connected in Settings, I can list your upcoming events, search your calendar, or schedule a new meeting.",
      "time": () => `The current local time is ${new Date().toLocaleTimeString()}.`,
      "date": () => `Today is ${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`,
      "creator": "I was crafted by your AI pair programmer utilizing multi-agent swarm architecture and high-performance Web APIs."
    };

    // Kick off Steam library fetch in the background on startup
    this._initSteamLibrary();
  }

  /**
   * Fetches the Steam library silently in the background on startup.
   */
  async _initSteamLibrary() {
    const lib = this.steamHarness.steamLibrary;
    if (!lib.isConfigured()) return;
    try {
      const games = await lib.fetchLibrary();
      if (games.length > 0) {
        this.onLog({
          type: 'SUCCESS',
          message: `[STEAM LIBRARY] Auto-loaded ${games.length} owned games. Voice game launch ready.`
        });
        this._updateAgentState('agent-4', 'ACTIVE', `Library: ${games.length} games indexed`);
      }
    } catch (e) {
      this.onLog({ type: 'WARNING', message: `[STEAM LIBRARY] Auto-load failed: ${e.message}` });
    }
  }

  /**
   * Main entry point when a user speaks or submits a text prompt to JARVIS
   */
  async processUserInput(rawInput, alternatives = []) {
    if (!rawInput || !rawInput.trim()) return;

    const input = rawInput.trim();
    this.onLog({
      type: 'USER',
      message: `[USER INPUT] "${input}"`
    });

    this.onStatusChange({ status: "THINKING", message: `JARVIS processing via ${this._activeProviderLabel()}...` });
    this.voiceEngine.playBeep(1200, 0.05, 'triangle');

    // 1. Notify Swarm: Queen & Reasoner agents process request
    this._updateAgentState("agent-1", "PROCESSING", `Routing request: "${input}"`);
    this._updateAgentState("agent-5", "EVALUATING", "Evaluating autonomous tool necessity");

    // 2. Perform Autonomous Tool Calling Evaluation — AI-first, regex fallback.
    // classifyIntentWithAI validates the response strictly (known toolName,
    // required params present) before it's ever trusted; any doubt at all
    // falls through to today's regex reasoner rather than risking a bad dispatch.
    let decision = await classifyIntentWithAI({
      input,
      classifyIntent: (i) => this._classifyIntentWithAI(i),
      onLog: this.onLog
    });
    if (!decision) {
      decision = this.toolReasoner.evaluateIntent(input);
    }

    // Guard against the AI classifier over-eagerly tagging a non-screen
    // question (e.g. "what is the weather in my location") as SCREEN_QUERY,
    // which would send it to screen vision to read a screenshot instead of
    // answering from live data. Only questions that actually reference the
    // screen/display stay on SCREEN_QUERY; everything else is redirected to
    // GOOGLE_SEARCH, which carries the get_location grounding tool.
    if (decision.toolName === 'SCREEN_QUERY') {
      // Test the FULL user input for a screen reference, not just the
      // classifier-extracted subject. The classifier often reduces a question
      // like "what's the temperature based on my screen?" down to the bare
      // word "temperature"; testing that against the screen pattern would
      // wrongly strip the "my screen" context and yank a genuine screen query
      // onto web search. When re-routing, use the full input as the search
      // query so context ("here", location, etc.) isn't lost to a bare word.
      if (!SCREEN_QUERY_PATTERN.test(input)) {
        this.onLog({ type: 'HARNESS', message: `[INTENT] Reclassified "${input}" from SCREEN_QUERY to GOOGLE_SEARCH (no screen reference).` });
        decision = {
          toolName: 'GOOGLE_SEARCH',
          params: { query: input },
          shouldCallTool: true,
          confidence: 0.9,
          reasoning: 'Reclassified non-screen question to web search.'
        };
      } else if (decision.params?.question !== input) {
        // Keep the full user question for the screen-vision call too, so the
        // model isn't handed just the classifier's bare subject ("temperature").
        decision.params = { ...decision.params, question: input };
      }
    }

    this.onLog({
      type: 'HARNESS',
      message: `[AUTONOMOUS REASONER] Tool: ${decision.toolName} (Confidence: ${(decision.confidence * 100).toFixed(0)}%) -> ${decision.reasoning}`
    });

    // 3. Handle Steam Launch Commands
    if (decision.toolName === 'STEAM_OPEN_CLIENT') {
      this._updateAgentState("agent-4", "EXECUTING", "Launching Steam Application");
      this.voiceEngine.playSearchLaunchSound();
      
      const result = this.steamHarness.launchSteam();
      const spokenResponse = "Initiating Steam desktop client launch protocol Sir.";

      this.onResponse({
        text: spokenResponse,
        actionType: 'STEAM_OPEN_CLIENT',
        data: result
      });

      this._updateAgentState("agent-4", "ACTIVE", "Steam client opened");
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    if (decision.toolName === 'STEAM_LAUNCH_GAME') {
      this._updateAgentState("agent-4", "EXECUTING", `Launching game: ${decision.params.gameQuery}`);
      this.voiceEngine.playSearchLaunchSound();

      const gameResult = await this.gameLauncherOrchestrator.launchGame(decision.params.gameQuery, alternatives);
      const spokenResponse = gameResult.success ? "Launching, Sir." : gameResult.message;

      this.onResponse({
        text: spokenResponse,
        actionType: 'STEAM_LAUNCH_GAME',
        data: gameResult
      });

      this._updateAgentState("agent-4", "ACTIVE", `Launched ${gameResult.gameName || decision.params.gameQuery}`);
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    // 4. Handle Spotify Commands
    if (decision.toolName === 'SPOTIFY_OPEN_CLIENT') {
      this._updateAgentState("agent-7", "EXECUTING", "Opening Spotify Application");
      this.voiceEngine.playSearchLaunchSound();

      const result = this.spotifyHarness.openApp();
      const spokenResponse = result.message;

      this.onResponse({
        text: spokenResponse,
        actionType: 'SPOTIFY_OPEN_CLIENT',
        data: result
      });

      this._updateAgentState("agent-7", "ACTIVE", "Spotify app opened");
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    if (decision.toolName === 'SPOTIFY_PLAY_SONG') {
      this._updateAgentState("agent-7", "EXECUTING", `Playing on Spotify: ${decision.params.query}`);
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.spotifyHarness.playSong(decision.params.query, this.spotifyClientId, this.spotifyClientSecret);
      const spokenResponse = result.message;

      this.onResponse({
        text: spokenResponse,
        actionType: 'SPOTIFY_PLAY_SONG',
        data: result
      });

      this._updateAgentState("agent-7", "ACTIVE", result.trackName ? `Playing ${result.trackName}` : `Searched Spotify for "${decision.params.query}"`);
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    if (decision.toolName === 'SPOTIFY_PLAY_LIBRARY') {
      const { kind, query } = decision.params;
      this._updateAgentState("agent-7", "EXECUTING", kind === 'liked' ? 'Opening Liked Songs' : `Playing ${kind}: ${query}`);
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.spotifyHarness.playFromLibrary({ kind, query, alternatives }, this.spotifyClientId, this.spotifyClientSecret);
      const spokenResponse = result.message;

      this.onResponse({
        text: spokenResponse,
        actionType: 'SPOTIFY_PLAY_LIBRARY',
        data: result
      });

      this._updateAgentState("agent-7", "ACTIVE", result.matchedName ? `Playing ${result.matchedName}` : `Searched Spotify for "${query}"`);
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    // 4b. Handle Epic Games Launcher Commands
    if (decision.toolName === 'EPIC_OPEN_CLIENT') {
      this._updateAgentState("agent-8", "EXECUTING", "Opening Epic Games Launcher");
      this.voiceEngine.playSearchLaunchSound();

      const result = this.epicGamesHarness.openApp();
      const spokenResponse = result.message;

      this.onResponse({
        text: spokenResponse,
        actionType: 'EPIC_OPEN_CLIENT',
        data: result
      });

      this._updateAgentState("agent-8", "ACTIVE", "Epic Games Launcher opened");
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    // 4c. Handle Xbox App Commands
    if (decision.toolName === 'XBOX_OPEN_CLIENT') {
      this._updateAgentState("agent-9", "EXECUTING", "Opening Xbox App");
      this.voiceEngine.playSearchLaunchSound();

      const result = this.xboxHarness.openApp();
      const spokenResponse = result.message;

      this.onResponse({
        text: spokenResponse,
        actionType: 'XBOX_OPEN_CLIENT',
        data: result
      });

      this._updateAgentState("agent-9", "ACTIVE", "Xbox App opened");
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    // 4d. Handle direct Xbox game-launch targeting ("launch X on xbox")
    if (decision.toolName === 'XBOX_LAUNCH_GAME') {
      this._updateAgentState("agent-9", "EXECUTING", `Launching game on Xbox: ${decision.params.gameQuery}`);
      this.voiceEngine.playSearchLaunchSound();

      const gameResult = await this.xboxHarness.launchGame(decision.params.gameQuery, alternatives);
      const spokenResponse = gameResult.message;

      this.onResponse({
        text: spokenResponse,
        actionType: 'XBOX_LAUNCH_GAME',
        data: gameResult
      });

      this._updateAgentState("agent-9", "ACTIVE", gameResult.success ? `Launched ${gameResult.gameName}` : `Not found: ${decision.params.gameQuery}`);
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    // 4e. Handle direct Epic Games game-launch targeting ("launch X on epic")
    if (decision.toolName === 'EPIC_LAUNCH_GAME') {
      this._updateAgentState("agent-8", "EXECUTING", `Launching game on Epic Games: ${decision.params.gameQuery}`);
      this.voiceEngine.playSearchLaunchSound();

      const gameResult = await this.epicGamesHarness.launchGame(decision.params.gameQuery, alternatives);
      const spokenResponse = gameResult.message;

      this.onResponse({
        text: spokenResponse,
        actionType: 'EPIC_LAUNCH_GAME',
        data: gameResult
      });

      this._updateAgentState("agent-8", "ACTIVE", gameResult.success ? `Launched ${gameResult.gameName}` : `Not found: ${decision.params.gameQuery}`);
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    // 5. Handle Model-Tier Switch Commands
    if (decision.toolName === 'SET_MODEL_TIER') {
      const tierKey = decision.params.tier;
      const tier = MODEL_TIERS[tierKey];
      const requiresGemini = tier.provider === 'gemini';
      const hasRequiredKey = requiresGemini ? Boolean(this.gemini.apiKey) : Boolean(this.groq.apiKey);

      let spokenResponse;
      if (!hasRequiredKey) {
        spokenResponse = requiresGemini
          ? "You'll need a Gemini API key in Settings first, Sir."
          : "You'll need a Groq API key in Settings first, Sir.";
      } else {
        // Ultra doesn't run on Groq, so switching to it shouldn't flip
        // useGroq on the way the other three tiers do — that flag only
        // governs the Groq/OpenRouter preference for non-Ultra chat.
        const settingsPatch = { groqModelTier: tierKey };
        if (!requiresGemini) settingsPatch.useGroq = true;
        saveSettings(settingsPatch);
        this.groq.setTier(tierKey);
        spokenResponse = `Switched to ${tier.label} mode, Sir.`;
      }

      this.onResponse({
        text: spokenResponse,
        actionType: 'SET_MODEL_TIER',
        data: { tier: tierKey, applied: hasRequiredKey }
      });

      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    // 6. Handle Math Queries via WolframAlpha
    if (decision.toolName === 'MATH_QUERY') {
      this._updateAgentState("agent-3", "COMPUTING", `Solving: "${decision.params.query}"`);
      this.voiceEngine.playSearchLaunchSound();

      const wolframAnswer = await this.wolfram.solve(decision.params.query);

      // WolframAlpha's spoken result is already a complete, correct answer —
      // speak it directly rather than routing it through the LLM, which
      // could second-guess a right answer into a wrong one. No key
      // configured or no result found both fall through to normal LLM chat.
      let spokenResponse;
      if (wolframAnswer) {
        spokenResponse = wolframAnswer;
      } else {
        const llmAnswer = await this._chatWithActiveLLM(
          `Answer this math question briefly and precisely as JARVIS, showing just the final answer, not your reasoning: ${decision.params.query}`,
          this.conversationHistory
        );
        spokenResponse = llmAnswer || `I wasn't able to compute that one, Sir.`;
      }

      this.onResponse({
        text: spokenResponse,
        actionType: 'MATH_QUERY',
        data: { query: decision.params.query, wolframAnswered: Boolean(wolframAnswer) }
      });

      this._updateAgentState("agent-3", "ACTIVE", `Computation complete: "${decision.params.query}"`);
      this._pushHistory(input, spokenResponse);
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    // 7. Handle Google Search Commands (Explicit or Autonomous)
    if (decision.toolName === 'GOOGLE_SEARCH') {
      // High/Ultra tiers are the largest, most capable models (High on Groq,
      // Ultra on Gemini) — the point of stepping up is to lean on that
      // model's own knowledge instead of paying the latency/noise cost of a
      // live web search, so skip the search grounding step entirely at
      // those tiers. See _prefersOwnKnowledge for the per-tier key checks.
      if (this._prefersOwnKnowledge()) {
        this._updateAgentState("agent-3", "THINKING", `Answering from model knowledge: "${decision.params.query}"`);
        this.onLog({
          type: 'HARNESS',
          message: `[TIER: ${MODEL_TIERS[this.groq.currentTier].label}] Skipping live web search — answering from the model's own knowledge.`
        });

        const llmAnswer = await this._chatWithActiveLLM(
          `Answer this question using your own knowledge, as JARVIS, in 2-3 sentences. Do not say you're searching or mention any browser. If you're not confident of the answer, say so honestly instead of guessing. IMPORTANT: If the question asks about the current weather or temperature somewhere, you MUST call get_location (when the user means 'here') then get_weather to retrieve the real data — do NOT ask the user to confirm, just call the tools and report the result. If the question depends on where the user is for any other reason (what's nearby, distances, directions), call get_location first: ${decision.params.query}`,
          this.conversationHistory,
          { tools: this.groundingTools, toolExecutor: this.toolExecutor }
        );
        const spokenResponse = llmAnswer || `I don't have a confident answer to that from memory alone, Sir.`;

        this.onResponse({
          text: spokenResponse,
          actionType: 'GOOGLE_SEARCH',
          data: { query: decision.params.query, skippedWebSearch: true, tier: this.groq.currentTier }
        });

        this._updateAgentState("agent-3", "ACTIVE", `Answered from knowledge: "${decision.params.query}"`);
        this._pushHistory(input, spokenResponse);
        await this.voiceEngine.speak(spokenResponse);
        return;
      }

      this._updateAgentState("agent-3", "SEARCHING", `Querying: "${decision.params.query}"`);
      this.voiceEngine.playSearchLaunchSound();

      // Search first so the LLM can be grounded in the real result instead
      // of guessing from its own (possibly stale/wrong) training knowledge.
      const searchResult = await this.harness.executeGoogleSearch(decision.params.query, loadSettings().openTabOnSearch);

      const weatherNudge = /weather|temperature|how (?:hot|cold) is it|feels like|forecast/i.test(decision.params.query)
        ? " IMPORTANT: The user is asking about the weather or current temperature. Ignore the search results above — you MUST call get_location first (for 'here' coordinates), then call get_weather to retrieve the real weather data. Do NOT ask the user to confirm — just call both tools and report the temperature. "
        : '';
      const llmPrompt = searchResult.summary
        ? `Live web search results for "${decision.params.query}":\n${searchResult.summary}\n\nUsing ONLY the information above, answer the user's question in 1-3 sentences as JARVIS. Do not say you're searching or mention any browser. If the results above don't actually answer the question, say so honestly instead of guessing.${weatherNudge}`
        : `Answer this question briefly in 2-3 sentences. Do not say you're searching or mention any browser. Just give the answer clearly: ${decision.params.query}${weatherNudge}`;

      const llmAnswer = await this._chatWithActiveLLM(llmPrompt, this.conversationHistory, {
        tools: this.groundingTools,
        toolExecutor: this.toolExecutor
      });

      // Priority: grounded LLM answer > raw web summary > minimal fallback
      let spokenResponse;
      if (llmAnswer) {
        spokenResponse = llmAnswer;
      } else if (searchResult.summary) {
        // Wikipedia/DDG summaries can run long — keep only the first couple
        // of sentences so the spoken response stays punchy.
        const trimmed = searchResult.summary.split('.').slice(0, 2).join('.').trim();
        spokenResponse = trimmed ? trimmed + '.' : searchResult.summary;
      } else {
        spokenResponse = `Let me take a quick look, Sir. I've pulled up the results in your HUD viewport.`;
      }

      this.onResponse({
        text: spokenResponse,
        actionType: 'GOOGLE_SEARCH',
        data: searchResult
      });

      this._updateAgentState("agent-3", "ACTIVE", `Search complete: "${decision.params.query}"`);
      this._pushHistory(input, spokenResponse);
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    // 8. Handle Direct Website Navigation
    if (decision.toolName === 'OPEN_SITE') {
      this._updateAgentState("agent-3", "EXECUTING", `Navigating to website: ${decision.params.siteName}`);
      this.voiceEngine.playSearchLaunchSound();

      const siteResult = this.harness.openWebsite(decision.params.siteName);
      const spokenResponse = `Opening ${decision.params.siteName.toUpperCase()} in a new tab Sir.`;

      this.onResponse({
        text: spokenResponse,
        actionType: 'OPEN_SITE',
        data: siteResult
      });

      this._updateAgentState("agent-3", "ACTIVE", `Opened ${decision.params.siteName}`);
      await this.voiceEngine.speak(spokenResponse);
      return;
    }

    // 8b. Handle Screen Monitoring Start
    if (decision.toolName === 'SCREEN_MONITOR_START') {
      this._updateAgentState("agent-3", "EXECUTING", "Arming screen monitoring");

      const result = await this.screenVisionHarness.startMonitoring();

      this.onResponse({
        text: result.message,
        actionType: 'SCREEN_MONITOR_START',
        data: result
      });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Screen monitoring active" : "Screen monitoring unavailable");
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8c. Handle Screen Monitoring Stop
    if (decision.toolName === 'SCREEN_MONITOR_STOP') {
      this._updateAgentState("agent-3", "EXECUTING", "Disarming screen monitoring");

      const result = await this.screenVisionHarness.stopMonitoring();

      this.onResponse({
        text: result.message,
        actionType: 'SCREEN_MONITOR_STOP',
        data: result
      });

      this._updateAgentState("agent-3", "ACTIVE", "Screen monitoring inactive");
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8d. Handle Screen Vision Questions
    if (decision.toolName === 'SCREEN_QUERY') {
      this._updateAgentState("agent-3", "EXECUTING", `Reading screen: "${decision.params.question}"`);
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.screenVisionHarness.askAboutScreen(decision.params.question);

      this.onResponse({
        text: result.message,
        actionType: 'SCREEN_QUERY',
        data: result
      });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Screen question answered" : "Screen capture failed");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8e. Handle Camera Vision Start (open the webcam + bounding-box overlay)
    if (decision.toolName === 'CAMERA_START') {
      this._updateAgentState("agent-3", "EXECUTING", "Activating camera vision");

      const result = this.cameraVisionHarness
        ? await this.cameraVisionHarness.open()
        : { success: false, message: 'Camera vision is not available here, Sir.' };

      this.onResponse({ text: result.message, actionType: 'CAMERA_START', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Camera feed active" : "Camera unavailable");
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8f. Handle Camera Vision Stop
    if (decision.toolName === 'CAMERA_STOP') {
      this._updateAgentState("agent-3", "EXECUTING", "Deactivating camera vision");

      const result = this.cameraVisionHarness
        ? this.cameraVisionHarness.close()
        : { success: false, message: 'Camera vision is not available here, Sir.' };

      this.onResponse({ text: result.message, actionType: 'CAMERA_STOP', data: result });

      this._updateAgentState("agent-3", "ACTIVE", "Camera feed inactive");
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8g. Handle Camera Vision Questions ("how many fingers am I holding up")
    if (decision.toolName === 'CAMERA_QUERY') {
      this._updateAgentState("agent-3", "EXECUTING", `Reading camera: "${decision.params.question}"`);
      this.voiceEngine.playSearchLaunchSound();

      const result = this.cameraVisionHarness
        ? await this.cameraVisionHarness.askAboutCamera(decision.params.question)
        : { success: false, message: 'Camera vision is not available here, Sir.' };

      this.onResponse({ text: result.message, actionType: 'CAMERA_QUERY', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Camera question answered" : "Camera capture failed");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8h. Handle Gmail Inbox Check ("check my email")
    if (decision.toolName === 'GMAIL_CHECK_INBOX') {
      this._updateAgentState("agent-3", "EXECUTING", "Checking Gmail inbox");
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.gmailHarness.listRecent(this.googleClientId, this.googleClientSecret);

      this.onResponse({ text: result.message, actionType: 'GMAIL_CHECK_INBOX', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Inbox checked" : "Gmail unavailable");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8i. Handle Gmail Search ("search my email for the invoice")
    if (decision.toolName === 'GMAIL_SEARCH') {
      this._updateAgentState("agent-3", "EXECUTING", `Searching Gmail: "${decision.params.query}"`);
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.gmailHarness.search(this.googleClientId, this.googleClientSecret, decision.params.query);

      this.onResponse({ text: result.message, actionType: 'GMAIL_SEARCH', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Gmail search complete" : "Gmail unavailable");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8j. Handle Gmail Read Message ("read me the email from Sarah")
    if (decision.toolName === 'GMAIL_READ_MESSAGE') {
      this._updateAgentState("agent-3", "EXECUTING", `Reading Gmail message: "${decision.params.query}"`);
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.gmailHarness.readMessage(this.googleClientId, this.googleClientSecret, decision.params.query);

      this.onResponse({ text: result.message, actionType: 'GMAIL_READ_MESSAGE', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Gmail message read" : "Gmail unavailable");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8k. Handle Calendar upcoming-events check ("what's on my calendar")
    if (decision.toolName === 'CALENDAR_LIST_UPCOMING') {
      this._updateAgentState("agent-3", "EXECUTING", "Checking calendar");
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.calendarHarness.listUpcoming(this.googleClientId, this.googleClientSecret);

      this.onResponse({ text: result.message, actionType: 'CALENDAR_LIST_UPCOMING', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Calendar checked" : "Calendar unavailable");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8l. Handle Calendar search ("search my calendar for the meeting about X")
    if (decision.toolName === 'CALENDAR_SEARCH') {
      this._updateAgentState("agent-3", "EXECUTING", `Searching calendar: "${decision.params.query}"`);
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.calendarHarness.search(this.googleClientId, this.googleClientSecret, decision.params.query);

      this.onResponse({ text: result.message, actionType: 'CALENDAR_SEARCH', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Calendar search complete" : "Calendar unavailable");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 8m. Handle Calendar create event ("schedule a meeting called X for Y").
    // Only the raw title + when-phrase leave the classifier/reasoner — the
    // harness owns resolving "when" into a real timestamp via chrono-node.
    if (decision.toolName === 'CALENDAR_CREATE_EVENT') {
      this._updateAgentState("agent-3", "EXECUTING", `Scheduling event: "${decision.params.title}"`);
      this.voiceEngine.playSearchLaunchSound();

      const result = await this.calendarHarness.createEvent(
        this.googleClientId,
        this.googleClientSecret,
        decision.params.title,
        decision.params.when
      );

      this.onResponse({ text: result.message, actionType: 'CALENDAR_CREATE_EVENT', data: result });

      this._updateAgentState("agent-3", "ACTIVE", result.success ? "Event scheduled" : "Event scheduling failed");
      this._pushHistory(input, result.message);
      await this.voiceEngine.speak(result.message);
      return;
    }

    // 9. Conversational Response via OpenRouter LLM (with Local Knowledge Base fallback)
    this._updateAgentState("agent-6", "THINKING", `Querying ${this._activeProviderLabel()} LLM API...`);

    // Grounding tools here (but not on the MATH_QUERY/GOOGLE_SEARCH paths
    // above, which have their own dedicated grounding logic) catch cases the
    // intent classifier didn't tag as a specific tool — see
    // docs/superpowers/specs/2026-08-14-grounding-tool-calling-design.md.
    let answerText = await this._chatWithActiveLLM(input, this.conversationHistory, {
      tools: this.groundingTools,
      toolExecutor: this.toolExecutor
    });

    if (answerText) {
      this.onLog({
        type: 'SUCCESS',
        message: `[LLM RESPONSE GENERATED] Neural completion received.`
      });
      this._updateAgentState("agent-6", "ACTIVE", "Completion delivered");
    } else {
      // Fallback to knowledge base matching if API is offline
      const lowerInput = input.toLowerCase();
      for (const [key, val] of Object.entries(this.knowledgeBase)) {
        if (lowerInput.includes(key)) {
          answerText = typeof val === 'function' ? val() : val;
          break;
        }
      }

      if (!answerText) {
        answerText = `I have logged your request: "${input}". The multi-agent swarm has processed the intent and updated system state.`;
      }
      this._updateAgentState("agent-6", "ACTIVE", "Fallback used");
    }

    this._updateAgentState("agent-2", "SPEAKING", "Synthesizing vocal response");
    
    this.onLog({
      type: 'JARVIS',
      message: `[JARVIS VOICE RESPONSE] "${answerText}"`
    });

    this.onResponse({
      text: answerText,
      actionType: 'QA_ANSWER',
      data: { query: input }
    });

    this._updateAgentState("agent-1", "ACTIVE", "Orchestration idle");
    this._updateAgentState("agent-5", "ACTIVE", "Standby for next command");
    this._pushHistory(input, answerText);

    // Speak response using voice engine
    await this.voiceEngine.speak(answerText);
    this._updateAgentState("agent-2", "ACTIVE", "Audio I/O standby");
  }

  /**
   * Routes a conversational request to the currently-selected LLM provider.
   * If useGroq is on but Groq returns nothing (no key, rate limit, network
   * error), falls through to OpenRouter — which itself falls through to the
   * local knowledge base in processUserInput if it also returns nothing.
   */
  /**
   * True when the active LLM path at the current tier is capable enough to
   * skip live search grounding — Groq at High tier (mirrors the same
   * preferGroq check _chatWithActiveLLM uses, so this doesn't fire based on
   * a tier setting that isn't even in effect), or Gemini at Ultra tier.
   */
  _prefersOwnKnowledge() {
    const tier = this.groq.currentTier;
    // Ultra only skips search grounding when Gemini is actually the model
    // answering — without a Gemini key, Ultra silently degrades to the
    // normal Groq/OpenRouter chat path (see _chatWithActiveLLM), which
    // isn't more capable than any other tier and still benefits from
    // live search grounding.
    if (tier === 'ultra') return Boolean(this.gemini.apiKey);
    if (tier !== 'high') return false;
    return loadSettings().useGroq || !this.openRouter.apiKey;
  }

  /**
   * Name of whichever provider _chatWithActiveLLM would actually reach for
   * right now, given the current tier/settings/keys — used purely for
   * status-line/log display (e.g. "JARVIS processing via Gemini...")
   * instead of hardcoding "OpenRouter" regardless of what's really
   * configured. Mirrors _chatWithActiveLLM's own routing decision exactly;
   * update both together if that logic ever changes.
   */
  _activeProviderLabel() {
    if (this.groq.currentTier === 'ultra' && this.gemini.apiKey) return 'Gemini';
    if (loadSettings().useHermes && this.hermes.apiKey) return 'Hermes';
    const preferGroq = loadSettings().useGroq || !this.openRouter.apiKey;
    if (preferGroq && this.groq.apiKey) return 'Groq';
    if (this.openRouter.apiKey) return 'OpenRouter';
    return 'local knowledge base';
  }

  async _chatWithActiveLLM(userInput, context, options = {}) {
    // Ultra tier routes to Gemini first, regardless of the Hermes/Groq/OpenRouter
    // preference below — if it has no key or fails, fall through to the
    // normal chain exactly as any other tier would.
    let answer;
    if (this.groq.currentTier === 'ultra' && this.gemini.apiKey) {
      answer = await this.gemini.chatWithJarvis(userInput, context, options);
      if (answer) return this._cleanLlmText(answer);
    }

    // Hermes — tried next when explicitly switched on and a key is
    // configured, ahead of the Groq/OpenRouter preference below, since it's
    // the more capable/agentic model for tool-calling (see
    // docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md).
    // Falls through on failure like every other provider.
    if (loadSettings().useHermes && this.hermes.apiKey) {
      answer = await this.hermes.chatWithJarvis(userInput, context, options);
      if (answer) return this._cleanLlmText(answer);
    }

    // Prefer Groq when explicitly switched on, or automatically when
    // OpenRouter has no key configured — this is what makes the OpenRouter
    // key optional as long as a Groq key is set. options.tools/toolExecutor
    // (both optional) pass straight through — see src/jarvis-tools.js.
    // Callers that want a tool-free answer (e.g. the MATH_QUERY fallback,
    // which already has its own dedicated math prompt) simply omit options.
    const preferGroq = loadSettings().useGroq || !this.openRouter.apiKey;
    if (preferGroq) {
      answer = await this.groq.chatWithJarvis(userInput, context, options);
      if (answer) return this._cleanLlmText(answer);
    }
    return this._cleanLlmText(await this.openRouter.chatWithJarvis(userInput, context, options));
  }

  /**
   * Strips any inline tool-call / function markers the LLM might have
   * emitted inside its answer text (e.g. `<function=...></function>`), so
   * the marker never leaks into the spoken line, transcript, or log.
   */
  _cleanLlmText(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/<function[^>]*>[\s\S]*?<\/function>/gi, '')
      .replace(/<function[^>]*\/>/gi, '')
      .trim();
  }

  /**
   * Narrow, grounded classification call used by the entity-resolution
   * fallback (see src/llm-entity-resolver.js) — picks the real target from a
   * candidate list rather than generating a conversational reply. Uses the
   * same Groq/OpenRouter provider-preference logic as _chatWithActiveLLM,
   * but calls generateCompletion() directly (bypassing the JARVIS-persona
   * prompt wrapper) with a low temperature and a short response budget.
   */
  async _resolveEntityWithLLM({ query, alternatives, candidates, kind }) {
    const transcripts = [query, ...alternatives].filter(Boolean);
    const messages = [
      {
        role: 'system',
        content: 'You resolve possibly-mistranscribed voice commands to a real target from a known list. The user\'s speech-to-text engine produced one or more guesses at what they said. Pick which item from the CANDIDATES list the user almost certainly meant. Respond with ONLY the exact candidate text, character-for-character, and nothing else. If none of the candidates plausibly match, respond with exactly: NONE'
      },
      {
        role: 'user',
        content: `Speech-to-text guesses (best guess first): ${transcripts.map(t => `"${t}"`).join(', ')}\nContext: user is trying to select a ${kind}.\nCANDIDATES:\n${candidates.map(c => `- ${c}`).join('\n')}`
      }
    ];

    const options = { temperature: 0.1, maxTokens: 30 };
    const preferGroq = loadSettings().useGroq || !this.openRouter.apiKey;

    const tryGroq = async () => {
      if (!this.groq.apiKey) return null;
      try {
        return await this.groq.generateCompletion(messages, options);
      } catch (e) {
        this.onLog({ type: 'WARNING', message: `[ENTITY RESOLVER] Groq failed: ${e.message}` });
        return null;
      }
    };
    const tryOpenRouter = async () => {
      if (!this.openRouter.apiKey) return null;
      try {
        return await this.openRouter.generateCompletion(messages, options);
      } catch (e) {
        this.onLog({ type: 'WARNING', message: `[ENTITY RESOLVER] OpenRouter failed: ${e.message}` });
        return null;
      }
    };

    if (preferGroq) {
      const groqAnswer = await tryGroq();
      if (groqAnswer) return groqAnswer;
      return tryOpenRouter();
    }
    const openRouterAnswer = await tryOpenRouter();
    if (openRouterAnswer) return openRouterAnswer;
    return tryGroq();
  }

  /**
   * Runs the AI-first intent classification call. Same Groq/OpenRouter
   * preferGroq logic as _resolveEntityWithLLM and _chatWithActiveLLM, but
   * calls generateCompletion() directly with a low temperature so the model
   * sticks to the requested JSON shape. Returns the raw string response (to
   * be parsed/validated by classifyIntentWithAI in ai-intent-classifier.js),
   * or null if no provider is configured or both fail.
   */
  async _classifyIntentWithAI(input) {
    const messages = [
      { role: 'system', content: INTENT_CLASSIFIER_SYSTEM_PROMPT },
      { role: 'user', content: input }
    ];
    // maxTokens is generous, not just enough for the short JSON answer: High
    // tier's openai/gpt-oss-120b is a genuine reasoning model that emits a
    // <think> block before its real output, and a tight budget gets consumed
    // by that reasoning before the JSON ever gets written, truncating it
    // mid-string (llm-completion.js's stripThinkTags only helps when the
    // <think> block actually closes within budget).
    const options = { temperature: 0.1, maxTokens: 600 };
    const preferGroq = loadSettings().useGroq || !this.openRouter.apiKey;

    const tryGroq = async () => {
      if (!this.groq.apiKey) return null;
      try {
        return await this.groq.generateCompletion(messages, options);
      } catch (e) {
        this.onLog({ type: 'WARNING', message: `[AI INTENT CLASSIFIER] Groq failed: ${e.message}` });
        return null;
      }
    };
    const tryOpenRouter = async () => {
      if (!this.openRouter.apiKey) return null;
      try {
        return await this.openRouter.generateCompletion(messages, options);
      } catch (e) {
        this.onLog({ type: 'WARNING', message: `[AI INTENT CLASSIFIER] OpenRouter failed: ${e.message}` });
        return null;
      }
    };

    if (preferGroq) {
      const groqAnswer = await tryGroq();
      if (groqAnswer) return groqAnswer;
      return tryOpenRouter();
    }
    const openRouterAnswer = await tryOpenRouter();
    if (openRouterAnswer) return openRouterAnswer;
    return tryGroq();
  }

  /**
   * Screen/camera-vision completion — same Groq/OpenRouter preferGroq
   * pattern as _resolveEntityWithLLM and _classifyIntentWithAI, but calls
   * the dedicated generateVisionCompletion() (a separate model queue —
   * most text models can't accept image content) with an OpenAI-compatible
   * vision message. Shared by both ScreenVisionHarness and
   * CameraVisionHarness (see their constructor wiring below) —
   * source distinguishes a screenshot from a live webcam frame so the
   * system prompt describes the image accurately.
   */
  async _askVisionLLM({ question, imageDataUrl, source = 'screen' }) {
    const sourceDescription = source === 'camera'
      ? "a live photo just captured from the user's webcam"
      : "a screenshot of the user's screen";
    const messages = [
      {
        role: 'system',
        content: `You are JARVIS, analyzing ${sourceDescription}. Answer their question about what is visible concisely (1-3 sentences), as JARVIS would speak it aloud. If the image doesn't contain enough information to answer, say so honestly.`
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      }
    ];
    // maxTokens is generous (not just enough for a 1-3 sentence answer)
    // because some vision models (e.g. Groq's qwen/qwen3.6-27b) emit a
    // <think>...</think> reasoning block before the real answer — too small
    // a budget truncates mid-thought with no answer at all. See
    // stripThinkTags in llm-completion.js, which strips that block out.
    // Grounding tools let the vision model call WolframAlpha instead of
    // eyeballing arithmetic off the screenshot — see
    // docs/superpowers/specs/2026-08-14-grounding-tool-calling-design.md.
    const options = { temperature: 0.3, maxTokens: 600, tools: this.groundingTools, toolExecutor: this.toolExecutor };

    // Ultra tier routes vision questions to Gemini first, same as
    // _chatWithActiveLLM does for text — Gemini takes images inline in the
    // same call, no separate vision model queue needed. Falls through to
    // the normal Groq/OpenRouter chain below on failure or no key, exactly
    // like the text path.
    if (this.groq.currentTier === 'ultra' && this.gemini.apiKey) {
      try {
        const geminiAnswer = await this.gemini.generateVisionCompletion(messages, options);
        if (geminiAnswer) return geminiAnswer;
      } catch (e) {
        this.onLog({ type: 'WARNING', message: `[GEMINI VISION] ${e.message}` });
      }
    }

    const preferGroq = loadSettings().useGroq || !this.openRouter.apiKey;

    const tryGroq = async () => {
      if (!this.groq.apiKey) return null;
      try {
        return await this.groq.generateVisionCompletion(messages, options);
      } catch (e) {
        this.onLog({ type: 'WARNING', message: `[SCREEN VISION] Groq failed: ${e.message}` });
        return null;
      }
    };
    const tryOpenRouter = async () => {
      if (!this.openRouter.apiKey) return null;
      try {
        return await this.openRouter.generateVisionCompletion(messages, options);
      } catch (e) {
        this.onLog({ type: 'WARNING', message: `[SCREEN VISION] OpenRouter failed: ${e.message}` });
        return null;
      }
    };

    if (preferGroq) {
      const groqAnswer = await tryGroq();
      if (groqAnswer) return groqAnswer;
      return tryOpenRouter();
    }
    const openRouterAnswer = await tryOpenRouter();
    if (openRouterAnswer) return openRouterAnswer;
    return tryGroq();
  }

  /**
   * Appends a user/assistant exchange to the rolling short-term memory buffer,
   * trimming to maxHistoryTurns so JARVIS remembers only the last few commands.
   */
  _pushHistory(userText, assistantText) {
    this.conversationHistory.push({ role: 'user', content: userText });
    this.conversationHistory.push({ role: 'assistant', content: assistantText });
    if (this.conversationHistory.length > this.maxHistoryTurns) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryTurns);
    }
  }

  _updateAgentState(agentId, status, lastAction) {
    const agent = this.swarmAgents.find(a => a.id === agentId);
    if (agent) {
      agent.status = status;
      agent.lastAction = lastAction;
      agent.calls++;
      this.onSwarmUpdate(this.swarmAgents);
    }
  }

  getSwarmStatus() {
    return {
      topology: "6-Agent Collaborative Mesh with OpenRouter LLM",
      consensus: "Autonomous Byzantine Agreement",
      agents: this.swarmAgents
    };
  }
}
