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
import { WolframClient } from './wolfram-client.js';
import { MODEL_TIERS } from './model-tiers.js';
import { loadSettings, saveSettings } from './settings.js';
import { classifyIntentWithAI, INTENT_CLASSIFIER_SYSTEM_PROMPT } from './ai-intent-classifier.js';
import { ScreenVisionHarness } from './screen-vision-harness.js';
import { GROUNDING_TOOLS, createToolExecutor } from './jarvis-tools.js';

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

    // Instantiate WolframAlpha Client (optional — grounds math answers in a
    // real computation instead of the LLM guessing; no key means MATH_QUERY
    // just falls through to the normal LLM chat path)
    const wolframAppId = localStorage.getItem('jarvis_wolfram_app_id') || '';

    this.wolfram = new WolframClient(wolframAppId, {
      onLog: (logData) => this.onLog(logData)
    });

    // Read-only grounding tools (WolframAlpha + web search) exposed to
    // autonomous LLM function-calling for screen vision and general chat —
    // see docs/superpowers/specs/2026-08-14-grounding-tool-calling-design.md.
    // Action tools (game launch, Spotify, etc.) stay off this list.
    this.groundingTools = GROUNDING_TOOLS;
    this.toolExecutor = createToolExecutor({
      wolfram: this.wolfram,
      harness: this.harness,
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

    this.onStatusChange({ status: "THINKING", message: "JARVIS processing via OpenRouter..." });
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
      const tier = MODEL_TIERS[decision.params.tier];
      const groqApiKey = this.groq.apiKey;

      let spokenResponse;
      if (!groqApiKey) {
        spokenResponse = "You'll need a Groq API key in Settings first, Sir.";
      } else {
        saveSettings({ groqModelTier: decision.params.tier, useGroq: true });
        this.groq.setTier(decision.params.tier);
        spokenResponse = `Switched to ${tier.label} mode, Sir.`;
      }

      this.onResponse({
        text: spokenResponse,
        actionType: 'SET_MODEL_TIER',
        data: { tier: decision.params.tier, applied: Boolean(groqApiKey) }
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
      // High/Ultra tiers are the larger, more capable Groq models — the
      // point of stepping up is to lean on that model's own knowledge
      // instead of paying the latency/noise cost of a live web search, so
      // skip the search grounding step entirely at those tiers. (Note:
      // Ultra runs groq/compound, Groq's own agentic model that can invoke
      // web search server-side on its own initiative regardless of this
      // flag — that's outside JARVIS's control.)
      if (this._prefersOwnKnowledge()) {
        this._updateAgentState("agent-3", "THINKING", `Answering from model knowledge: "${decision.params.query}"`);
        this.onLog({
          type: 'HARNESS',
          message: `[TIER: ${MODEL_TIERS[this.groq.currentTier].label}] Skipping live web search — answering from the model's own knowledge.`
        });

        const llmAnswer = await this._chatWithActiveLLM(
          `Answer this question using your own knowledge, as JARVIS, in 2-3 sentences. Do not say you're searching or mention any browser. If you're not confident of the answer, say so honestly instead of guessing: ${decision.params.query}`,
          this.conversationHistory
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

      const llmPrompt = searchResult.summary
        ? `Live web search results for "${decision.params.query}":\n${searchResult.summary}\n\nUsing ONLY the information above, answer the user's question in 1-3 sentences as JARVIS. Do not say you're searching or mention any browser. If the results above don't actually answer the question, say so honestly instead of guessing.`
        : `Answer this question briefly in 2-3 sentences. Do not say you're searching or mention any browser. Just give the answer clearly: ${decision.params.query}`;

      const llmAnswer = await this._chatWithActiveLLM(llmPrompt, this.conversationHistory);

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

    // 9. Conversational Response via OpenRouter LLM (with Local Knowledge Base fallback)
    this._updateAgentState("agent-6", "THINKING", "Querying OpenRouter LLM API...");

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
        message: `[OPENROUTER RESPONSE GENERATED] Neural completion received.`
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
   * True when the active LLM path would actually be Groq at High/Ultra
   * tier — mirrors the same preferGroq check _chatWithActiveLLM uses, so
   * this doesn't fire based on a tier setting that isn't even in effect
   * (e.g. useGroq off with an OpenRouter key present).
   */
  _prefersOwnKnowledge() {
    const tier = this.groq.currentTier;
    if (tier !== 'high' && tier !== 'ultra') return false;
    return loadSettings().useGroq || !this.openRouter.apiKey;
  }

  async _chatWithActiveLLM(userInput, context, options = {}) {
    // Prefer Groq when explicitly switched on, or automatically when
    // OpenRouter has no key configured — this is what makes the OpenRouter
    // key optional as long as a Groq key is set. options.tools/toolExecutor
    // (both optional) pass straight through — see src/jarvis-tools.js.
    // Callers that want a tool-free answer (e.g. the MATH_QUERY fallback,
    // which already has its own dedicated math prompt) simply omit options.
    const preferGroq = loadSettings().useGroq || !this.openRouter.apiKey;
    if (preferGroq) {
      const groqAnswer = await this.groq.chatWithJarvis(userInput, context, options);
      if (groqAnswer) return groqAnswer;
    }
    return this.openRouter.chatWithJarvis(userInput, context, options);
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
    const options = { temperature: 0.1, maxTokens: 200 };
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
   * Screen-vision completion — same Groq/OpenRouter preferGroq pattern as
   * _resolveEntityWithLLM and _classifyIntentWithAI, but calls the dedicated
   * generateVisionCompletion() (a separate model queue — most text models
   * can't accept image content) with an OpenAI-compatible vision message.
   */
  async _askVisionLLM({ question, imageDataUrl }) {
    const messages = [
      {
        role: 'system',
        content: "You are JARVIS, analyzing a screenshot of the user's screen. Answer their question about what is visible concisely (1-3 sentences), as JARVIS would speak it aloud. If the screenshot doesn't contain enough information to answer, say so honestly."
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
