import { VoiceEngine } from './voice-engine.js';
import { BrowserHarness } from './harness.js';
import { JarvisCore } from './jarvis-core.js';
import { ConversationController } from './conversation-controller.js';
import { loadSettings, saveSettings } from './settings.js';
import { isUpdateSupported, getCurrentVersion, checkForUpdate, downloadUpdate, installUpdate, onUpdateState, getChangelog } from './update-manager.js';
import { MODEL_TIERS, TIER_ORDER } from './model-tiers.js';
import { CameraVisionHarness } from './camera-vision-harness.js';
import { LocationHarness } from './location-harness.js';
import { FileSystemHarness } from './file-harness.js';
import { loadTasks, addTask, toggleTask, removeTask, clearCompleted } from './tasks-store.js';
import { QUOTES, nextQuoteIndex } from './quotes.js';
import { DisplayPanel } from './display-panel.js';

// DOM Element References
const micBtn = document.getElementById('micBtn');
const transcriptDisplay = document.getElementById('transcriptDisplay');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const spokenLine = document.getElementById('spokenLine');
const terminalBox = document.getElementById('terminalBox');
const swarmList = document.getElementById('swarmList');
const steamGamesGrid = document.getElementById('steamGamesGrid');
const launchSteamBtn = document.getElementById('launchSteamBtn');
const muteBtn = document.getElementById('muteBtn');
const stopBtn = document.getElementById('stopBtn');
const cameraVideo = document.getElementById('cameraVideo');
const cameraOverlayCanvas = document.getElementById('cameraOverlayCanvas');
const cameraViewport = document.getElementById('cameraViewport');
const viewportPlaceholder = document.getElementById('viewportPlaceholder');
const viewportFrame = document.getElementById('viewportFrame');
const viewportTitle = document.getElementById('viewportTitle');
const viewportExternalLink = document.getElementById('viewportExternalLink');
const tabsOpenedCount = document.getElementById('tabsOpenedCount');
const visualizerCanvas = document.getElementById('visualizerCanvas');
const arcReactorContainer = document.querySelector('.arc-reactor-container');
const speechMeter = document.getElementById('speechMeter');
const speechMeterBars = speechMeter ? Array.from(speechMeter.querySelectorAll('.speech-meter-bar')) : [];
const neuralCanvas = document.getElementById('neuralSphere');
const neuralStage = document.getElementById('sphereStage');
const homeView = document.getElementById('view-home');
// Big display popup for visual answers — the core docks to the bottom-right
// corner while it is open (choreography lives in display-panel.js).
const displayPanel = new DisplayPanel({
  stageEl: neuralStage,
  panelEl: document.getElementById('displayPanel'),
  titleEl: document.getElementById('displayPanelTitle'),
  bodyEl: document.getElementById('displayPanelBody'),
  closeBtnEl: document.getElementById('displayPanelClose')
});
window.__displayPanel = displayPanel;

/**
 * Live voice-state painter for the System Status card's Voice row — the
 * dedicated sidebar status card was cut as redundant, and this row took
 * over its job: colored dot (listening cyan / thinking pink / speaking gold)
 * plus an Idle-Listening-Thinking-Speaking label.
 */
const VOICE_STATE_LABEL = {
  LISTENING: 'Listening',
  THINKING: 'Thinking',
  SPEAKING: 'Speaking',
  IDLE: 'Idle',
  ERROR: 'Mic error'
};
let lastVoiceState = 'IDLE';
function paintVoiceState(status) {
  if (!VOICE_STATE_LABEL[status]) status = lastVoiceState; // unknown/legacy states keep the last known
  lastVoiceState = status;
  const mic = document.getElementById('sysMic');
  if (mic) mic.textContent = VOICE_STATE_LABEL[status];
  const dot = document.getElementById('sysVoiceDot');
  if (dot) {
    dot.className = 'dot';
    if (status === 'LISTENING' || status === 'THINKING' || status === 'SPEAKING' || status === 'ERROR') {
      dot.classList.add(status.toLowerCase());
    }
  }
}

// Visualizer Canvas Context
const ctx = visualizerCanvas ? visualizerCanvas.getContext('2d') : null;
let animationFrameId = null;
let meterLevel = 0; // 0..1 current displayed level, decays over time
let meterDecayFrameId = null;

// Neural sphere state
const nctx = neuralCanvas ? neuralCanvas.getContext('2d') : null;
let neuralFrameId = null;
let neuralAngle = 0;
let neuralTilt = 0.35;
const neuralColor = { r: 110, g: 175, b: 255 }; // lerped toward the state target each frame
let spherePts = [];
let sphereEdges = [];
let sphereAdj = [];
// Drag-to-spin globe state: flick velocity decays into inertia after release.
let neuralDragging = false;
let neuralDragWired = false;
let dragVelX = 0, dragVelY = 0, userTilt = 0, dragGlow = 0;
let lastPX = 0, lastPY = 0;

// Initialize System Components
let voiceEngine;
let harness;
let jarvis;
let isMuted = false;
let isThinking = false; // drives the pink "thinking" glow on the reactor core/waveform

// Wake-word / conversation-mode state machine ("Aria" / "Hey Aria")
const conversationController = new ConversationController();
let wakeTimeoutId = null;
let conversationTimeoutId = null;

/**
 * Stops whatever ARIA is doing right now: cuts speech, drops any queued
 * follow-up, ends the conversation, and clears pending timers. An in-flight
 * LLM reply may still land once, but it will not be spoken over the stop.
 */
function stopAll() {
  if (voiceEngine) voiceEngine.stopSpeaking();
  conversationController.reset();
  clearTimeout(wakeTimeoutId);
  clearTimeout(conversationTimeoutId);
  if (jarvis) jarvis._queuedInput = null;
  // The sphere's thinking streak reads isThinking — without clearing it here
  // the yellow chase would run forever after a stop.
  isThinking = false;
  paintVoiceState('IDLE');
  restoreGreeting();
  pushActivity('HARNESS', '[STOP] Current task stopped by the user.');
}

/**
 * Stop-button handler (topbar ■). Doubles as a mic revival switch: if the
 * engine is fully down (not listening, not armed, not speaking), the click
 * restarts wake-word listening instead — that's also what the mic-error
 * messages point at.
 */
function onStopBtn() {
  if (voiceEngine && !voiceEngine.isListening && !voiceEngine.isSpeaking && !voiceEngine.continuousMode) {
    if (voiceEngine.startListening() !== false) return;
  }
  stopAll();
}

function initApp() {
  // 1. Terminal logger helper
  const addLog = ({ type = 'ARIA', message }) => {
    if (!terminalBox) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${message}`;
    terminalBox.appendChild(entry);
    terminalBox.scrollTop = terminalBox.scrollHeight;
    pushActivity(type, message);
  };

  // 2. Status updater helper. The dedicated sidebar status card is gone —
  // the live state now rides on the System Status card's Voice row.
  const updateStatus = ({ status, message }) => {
    paintVoiceState(status);
    isThinking = status === 'THINKING';
    if (arcReactorContainer) arcReactorContainer.classList.toggle('thinking', isThinking);

    if (message && transcriptDisplay) {
      transcriptDisplay.textContent = message;
    }
  };

  // 3. Harness Browser Viewport updater helper
  const updateViewport = ({ title, url, iframeUrl, tabOpened }) => {
    if (viewportTitle) viewportTitle.textContent = title;
    if (viewportExternalLink) {
      viewportExternalLink.href = url;
      viewportExternalLink.style.display = 'inline';
    }

    if (viewportPlaceholder) viewportPlaceholder.style.display = 'none';
    if (viewportFrame) {
      viewportFrame.style.display = 'block';
      try {
        viewportFrame.src = iframeUrl || url;
      } catch (e) {
        console.warn("Iframe load issue", e);
      }
    }

    if (harness && tabsOpenedCount) {
      tabsOpenedCount.textContent = `TABS OPENED: ${harness.tabsOpened}`;
    }
  };

  // 4. Swarm Telemetry UI Updater
  const renderSwarmTelemetry = (agents) => {
    if (!swarmList || !agents) return;
    swarmList.innerHTML = '';
    agents.forEach(agent => {
      const card = document.createElement('div');
      card.className = 'swarm-agent-card';
      const statusClass = agent.status ? agent.status.toLowerCase() : 'active';
      const lastActionHtml = agent.lastAction ? ` &bull; <span style="font-size:0.7rem; color:var(--text-dim);">${agent.lastAction}</span>` : '';

      card.innerHTML = `
        <div>
          <div class="agent-role">${agent.role}</div>
          <div class="agent-domain">${agent.domain}${lastActionHtml}</div>
        </div>
        <span class="agent-status-badge ${statusClass}">${agent.status}</span>
      `;
      swarmList.appendChild(card);
    });
    const sysSummary = document.getElementById('sysSummary');
    if (sysSummary) {
      const active = agents.filter(a => String(a.status || '').toUpperCase() === 'ACTIVE').length;
      sysSummary.textContent = `${active}/${agents.length} agents active · ${(jarvis && jarvis._activeProviderLabel && jarvis._activeProviderLabel()) || 'starting'}`;
    }
  };

  // 5. Instantiate Harness, Voice, & Core
  harness = new BrowserHarness({
    onLog: addLog,
    onViewportUpdate: updateViewport
  });

  voiceEngine = new VoiceEngine({
    onTranscript: ({ text, isFinal, alternatives = [] }) => {
      if (transcriptDisplay && !conversationController.isAwaitingCommand) transcriptDisplay.textContent = text;
      if (!isFinal || !jarvis) return;

      const result = conversationController.handleTranscript(text, alternatives);

      if (result.action === 'IGNORE') {
        // Not addressed to ARIA — ignore ambient speech while passively listening.
        return;
      }

      if (result.action === 'AWAIT_COMMAND') {
        // Always chime the instant the wake word is heard, whether or not a
        // command follows immediately — this is the "yes, I heard you" cue.
        voiceEngine.playBeep(1000, 0.08, 'sine');
        if (transcriptDisplay) transcriptDisplay.textContent = 'Yes, Sir? Listening for your command...';
        clearTimeout(wakeTimeoutId);
        wakeTimeoutId = setTimeout(() => {
          conversationController.onWakeTimeout();
          if (transcriptDisplay) transcriptDisplay.textContent = 'Say "Aria" to give a command...';
        }, conversationController.wakeTimeoutMs);
        return;
      }

      if (result.action === 'DISPATCH_COMMAND') {
        clearTimeout(wakeTimeoutId);
        if (result.chime) {
          // "Hey Aria, play Dota" — wake word + command in one breath. This is
          // the only case that needs a fresh chime here: the AWAIT_COMMAND branch
          // above already played it when "Aria" was said alone, and in-conversation
          // follow-ups intentionally stay silent (see spec: no chime per turn).
          voiceEngine.playBeep(1000, 0.08, 'sine');
        }
        clearTimeout(conversationTimeoutId);
        conversationTimeoutId = setTimeout(() => {
          conversationController.onConversationTimeout();
          voiceEngine.playBeep(500, 0.12, 'sine');
          if (transcriptDisplay) transcriptDisplay.textContent = 'Conversation ended. Say "Aria" to start.';
        }, conversationController.conversationTimeoutMs);
        jarvis.processUserInput(result.command, result.alternatives);
        return;
      }

      if (result.action === 'END_CONVERSATION') {
        clearTimeout(conversationTimeoutId);
        voiceEngine.playBeep(500, 0.12, 'sine');
        if (transcriptDisplay) transcriptDisplay.textContent = 'Conversation ended. Say "Aria" to start.';
      }
    },
    onStateChange: (state) => {
      updateStatus(state);
      if (micBtn) {
        if (state.status === 'LISTENING') {
          micBtn.classList.add('active');
        } else if (state.status === 'IDLE' || state.status === 'ERROR') {
          micBtn.classList.remove('active');
        }
      }
      // Speech finished (or engine went quiet) — hero reverts to standby.
      if (state.status === 'IDLE') restoreGreeting();
    },
    onSpeechMeter: ({ active, intensity }) => {
      if (active) pulseMeter(intensity);
    },
    onLog: addLog
  });

  const cameraVisionHarness = new CameraVisionHarness({
    videoEl: cameraVideo,
    canvasEl: cameraOverlayCanvas,
    panelEl: cameraViewport,
    onLog: addLog
  });

  jarvis = new JarvisCore(voiceEngine, harness, {
    onLog: addLog,
    onStatusChange: updateStatus,
    cameraVisionHarness,
    // Visual answers (math results, SVG drawings) push onto the big display
    // popup — the core flies into the bottom-right corner while it's open.
    onDisplay: (payload) => displayPanel.open(payload),
    onResponse: ({ text, actionType, data }) => {
      // Chat-style reply entry ("ARIA: response") — the core no longer logs
      // its own [ARIA VOICE RESPONSE] copy, so this is the single line.
      addLog({ type: 'ARIA', message: `ARIA: ${text}` });
      showAriaResponse(text);
      if (spokenLine) spokenLine.textContent = text;
      if (actionType === 'SET_MODEL_TIER') {
        // On success, sync the slider to the tier that was just applied. On
        // failure (e.g. dragged to Ultra with a Groq key but no Gemini key)
        // snap it back to whatever tier is actually still active, rather
        // than leaving the thumb sitting on a switch that didn't happen.
        syncTierControl(data?.applied ? data.tier : jarvis.groq.currentTier);
      }
      if (actionType === 'CAMERA_START' || actionType === 'CAMERA_STOP' || actionType === 'CAMERA_QUERY') {
        const cameraStatus = document.getElementById('cameraStatus');
        if (cameraStatus) cameraStatus.textContent = text;
        syncCameraButtons();
        // Bring the live feed on screen the moment the camera is on.
        if (actionType === 'CAMERA_START' && data && data.success) {
          switchView('devices');
        }
      }
    },
    onSwarmUpdate: renderSwarmTelemetry
  });

  // Render initial swarm telemetry state
  const swarmStatus = jarvis.getSwarmStatus();
  renderSwarmTelemetry(swarmStatus.agents);

  // 6. Populate Steam Games Grid (initial — hardcoded fallbacks)
  populateSteamGames();

  // After 3s, refresh game grid in case the Steam library finished loading
  setTimeout(() => populateSteamGames(), 3000);

  // 7. Attach Steam Launch Button Handler
  if (launchSteamBtn) {
    launchSteamBtn.addEventListener('click', () => {
      jarvis.processUserInput('Open Steam');
    });
  }

  // 8. Overlay message handler — when the overlay sends a message, process it through ARIA
  if (window.jarvisElectron?.overlay) {
    window.jarvisElectron.overlay.onMessage(async (data) => {
      if (!jarvis || !data || !data.text) return;
      try {
        // Capture the response text from ARIA's onResponse callback
        let responseText = 'Processed.';
        const originalOnResponse = jarvis.onResponse;
        jarvis.onResponse = (resp) => {
          if (resp && resp.text) responseText = resp.text;
          if (originalOnResponse) originalOnResponse(resp);
        };
        await jarvis.processUserInput(data.text);
        // Restore original onResponse
        jarvis.onResponse = originalOnResponse;
        window.jarvisElectron.overlay.sendResponse(responseText);
      } catch (e) {
        window.jarvisElectron.overlay.sendResponse('I encountered an error processing your request.');
      }
    });
  }
  const steamApiKeyInput = document.getElementById('steamApiKeyInput');
  const steamIdInput = document.getElementById('steamIdInput');
  const steamSaveBtn = document.getElementById('steamSaveBtn');
  const steamClearBtn = document.getElementById('steamClearBtn');
  const steamLibraryStatus = document.getElementById('steamLibraryStatus');

  // Pre-fill inputs if credentials are already saved
  if (steamApiKeyInput && jarvis.steamHarness.steamLibrary.isConfigured()) {
    steamApiKeyInput.placeholder = '••••••••••••••••• (saved)';
    steamIdInput.value = localStorage.getItem('jarvis_steam_id') || '';
    steamLibraryStatus.textContent = 'Credentials saved — library will load on next command.';
    steamLibraryStatus.style.color = 'var(--cyan-bright)';
  }

  if (steamSaveBtn) {
    steamSaveBtn.addEventListener('click', async () => {
      const key = steamApiKeyInput ? steamApiKeyInput.value.trim() : '';
      const id = steamIdInput ? steamIdInput.value.trim() : '';

      if (!key || !id) {
        if (steamLibraryStatus) {
          steamLibraryStatus.textContent = '⚠ Both API Key and Steam ID are required.';
          steamLibraryStatus.style.color = 'var(--red-alert)';
        }
        return;
      }

      jarvis.steamHarness.steamLibrary.configure(key, id);
      if (steamLibraryStatus) {
        steamLibraryStatus.textContent = '⏳ Loading your Steam library...';
        steamLibraryStatus.style.color = 'var(--gold-glow)';
      }
      steamSaveBtn.disabled = true;

      try {
        const games = await jarvis.steamHarness.steamLibrary.fetchLibrary(true);
        if (steamLibraryStatus) {
          steamLibraryStatus.textContent = `✅ ${games.length} games loaded from your Steam library.`;
          steamLibraryStatus.style.color = '#70a1ff';
        }
        addLog({ type: 'SUCCESS', message: `[STEAM LIBRARY] ${games.length} owned games indexed. Voice launch ready.` });
        populateSteamGames(); // Refresh grid with real library
      } catch (err) {
        if (steamLibraryStatus) {
          steamLibraryStatus.textContent = `❌ Error: ${err.message}`;
          steamLibraryStatus.style.color = 'var(--red-alert)';
        }
      } finally {
        steamSaveBtn.disabled = false;
        if (steamApiKeyInput) steamApiKeyInput.value = '';
        if (steamApiKeyInput) steamApiKeyInput.placeholder = '••••••••••••••••• (saved)';
      }
    });
  }

  if (steamClearBtn) {
    steamClearBtn.addEventListener('click', () => {
      jarvis.steamHarness.steamLibrary.clearCache();
      localStorage.removeItem('jarvis_steam_api_key');
      localStorage.removeItem('jarvis_steam_id');
      if (steamApiKeyInput) { steamApiKeyInput.value = ''; steamApiKeyInput.placeholder = 'Steam Web API Key'; }
      if (steamIdInput) steamIdInput.value = '';
      if (steamLibraryStatus) { steamLibraryStatus.textContent = 'Not connected'; steamLibraryStatus.style.color = 'var(--text-dim)'; }
      populateSteamGames();
      addLog({ type: 'HARNESS', message: '[STEAM LIBRARY] Credentials and cache cleared.' });
    });
  }

  // 8b. Settings Panel (general prefs, voice gender, sound meter, API keys)
  initSettingsPanel();

  // 8c. Software Update Panel (Electron-only — no-op in plain browser dev mode)
  initUpdatePanel();

  // 8c2. Spotify Account Connection Panel (Electron-only — OAuth needs the
  // main-process loopback server)
  initSpotifyAccountPanel();

  // 8c3. Google Account Connection Panel (Electron-only — OAuth needs the
  // main-process loopback server)
  initGoogleAccountPanel();

  // 8d. Model-Tier Slider (Quick/Medium/High on Groq, Ultra on Gemini)
  initTierControl();

  // 8e. Camera Vision Harness Panel (live COCO-SSD bounding-box overlay)
  initCameraVisionPanel();

  // 8f. Location Panel (one-shot Leaflet map of the user's current position)
  initLocationPanel();

  // 8g. ARIA dashboard shell (nav, greeting, rail, tasks, calendar, memory)
  initDashboard(addLog);

  // Voice & Mute Control Handlers (the stop button is bound once in
  // initDashboard alongside command-bar focus; the legacy mic button is
  // gone from the UI, micBtn stays null-guarded regardless)

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      isMuted = !isMuted;
      if (isMuted) {
        voiceEngine.stopSpeaking();
        if (voiceEngine) voiceEngine.isMuted = true;
        muteBtn.textContent = '🔇 VOICE: OFF';
        muteBtn.style.borderColor = 'var(--red-alert)';
        muteBtn.style.color = 'var(--red-alert)';
      } else {
        if (voiceEngine) voiceEngine.isMuted = false;
        muteBtn.textContent = '🔊 VOICE: ON';
        muteBtn.style.borderColor = 'var(--border-gold)';
        muteBtn.style.color = 'var(--gold-glow)';
      }
    });
  }

  // 9. Text Input & Send Button Handlers
  const handleManualInput = () => {
    if (!textInput) return;
    const val = textInput.value.trim();
    if (!val) return;
    textInput.value = '';

    // Typed "end conversation"/"stop"/"goodbye" end the session here rather
    // than being sent to the LLM as a chat prompt (the voice path handles
    // this in ConversationController.handleTranscript — see its stop check).
    if (conversationController.isStopPhrase(val)) {
      clearTimeout(conversationTimeoutId);
      conversationController.reset();
      voiceEngine.playBeep(500, 0.12, 'sine');
      if (transcriptDisplay) transcriptDisplay.textContent = 'Conversation ended. Say "Aria" to start.';
      return;
    }

    jarvis.processUserInput(val);
  };

  if (sendBtn) {
    sendBtn.addEventListener('click', handleManualInput);
  }

  if (textInput) {
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleManualInput();
    });
  }

  // 10. Quick Action Harness Buttons
  document.querySelectorAll('.btn-harness').forEach(btn => {
    if (btn.id === 'muteBtn') return;
    btn.addEventListener('click', () => {
      const query = btn.getAttribute('data-query');
      if (query) {
        jarvis.processUserInput(query);
      }
    });
  });

  // 11. Start Arc Reactor Waveform Animation
  if (visualizerCanvas && ctx) {
    startVisualizerAnimation();

    // The Electron window starts hidden (tray-only) and Chromium suspends
    // requestAnimationFrame for windows that have never been shown, so the
    // loop above may never actually get going. Force a restart the moment
    // the window becomes visible (e.g. opened from the tray icon).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        startVisualizerAnimation();
        startNeuralSphere();
      }
    });
  }

  // 11b. Neural sphere hero background (Home view).
  if (neuralCanvas && nctx) {
    startNeuralSphere();
    if (typeof ResizeObserver !== 'undefined' && neuralStage) {
      new ResizeObserver(() => sizeNeuralCanvas()).observe(neuralStage);
    } else {
      window.addEventListener('resize', sizeNeuralCanvas);
    }
  }

  addLog({
    type: 'SUCCESS',
    message: '[SWARM ONLINE] Multi-Agent Mesh active. Voice I/O, Steam Harness, & Google Automation primed.'
  });

  // 12. Auto-start passive wake-word listening — no manual mic click required.
  // Browsers may still show a one-time microphone permission prompt.
  const wakeStarted = voiceEngine.startListening();
  if (wakeStarted !== false) {
    if (micBtn) micBtn.classList.add('active');
    if (transcriptDisplay) transcriptDisplay.textContent = 'Say "Aria" to give a command...';
    addLog({ type: 'HARNESS', message: '[WAKE WORD] Passive listening active. Say "Aria" or "Hey Aria" to issue a command.' });
  }

  // 13. Boot sequence complete — flip the status and fade the boot screen
  // (the inline failsafe owns minimum-display timing + failure fallback).
  const bootStatus = document.getElementById('bootStatus');
  if (bootStatus) bootStatus.textContent = 'System online';
  if (typeof window !== 'undefined' && typeof window.__ariaHideBoot === 'function') {
    window.__ariaHideBoot();
  }
}

/**
 * Populates steamGamesGrid with featured games from jarvis.steamHarness
 */
function populateSteamGames() {
  if (!steamGamesGrid || !jarvis || !jarvis.steamHarness) return;
  const games = jarvis.steamHarness.getFeaturedGames();
  steamGamesGrid.innerHTML = '';

  games.forEach(game => {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.setAttribute('data-game-name', game.name);
    card.innerHTML = `
      <div class="game-icon">${game.icon || '🎮'}</div>
      <div class="game-info">
        <div class="game-title">${game.name}</div>
        <span class="game-genre">${game.genre}</span>
      </div>
      <button class="game-launch-btn" title="Launch ${game.name}">PLAY ▶</button>
    `;
    card.addEventListener('click', () => {
      jarvis.processUserInput(`Play ${game.name}`);
    });
    steamGamesGrid.appendChild(card);
  });
  const librarySummary = document.getElementById('librarySummary');
  if (librarySummary && jarvis && jarvis.steamHarness) {
    const connected = jarvis.steamHarness.steamLibrary.isConfigured();
    librarySummary.textContent = connected
      ? `${games.length} games ready — say "play ..." to launch.`
      : 'Steam library not connected.';
  }
}

/**
 * Renders high-tech glowing arc-reactor waveform visualizer on Canvas
 */
function startVisualizerAnimation() {
  if (!visualizerCanvas || !ctx) return;

  // Guard against a duplicate loop (e.g. re-triggered by visibilitychange
  // while one is already running) rather than stacking multiple RAF chains.
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  const width = visualizerCanvas.width;
  const height = visualizerCanvas.height;
  const centerX = width / 2;
  const centerY = height / 2;
  let phase = 0;

  function render() {
    ctx.clearRect(0, 0, width, height);

    phase += 0.04;
    const isSpeaking = voiceEngine ? voiceEngine.isSpeaking : false;
    const isListening = voiceEngine ? voiceEngine.isListening : false;

    // Glowing Central Core
    const coreRadius = isSpeaking ? 42 + Math.sin(phase * 4) * 8 : (isListening ? 38 + Math.sin(phase * 2) * 5 : (isThinking ? 40 + Math.sin(phase * 3) * 6 : 34));
    const grad = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, coreRadius * 1.8);

    if (isSpeaking) {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, '#ffaa00');
      grad.addColorStop(1, 'rgba(255, 51, 102, 0.0)');
    } else if (isListening) {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, '#00f3ff');
      grad.addColorStop(1, 'rgba(0, 119, 255, 0.0)');
    } else if (isThinking) {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, '#ff007f');
      grad.addColorStop(1, 'rgba(255, 0, 127, 0.0)');
    } else {
      grad.addColorStop(0, 'rgba(226, 241, 255, 0.9)');
      grad.addColorStop(0.4, 'rgba(0, 243, 255, 0.6)');
      grad.addColorStop(1, 'rgba(0, 119, 255, 0.0)');
    }

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(centerX, centerY, coreRadius * 1.6, 0, Math.PI * 2);
    ctx.fill();

    // Waveform Ring
    const points = 64;
    const baseRadius = 85;
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2;
      const amp = isSpeaking ? 16 * Math.sin(phase * 3 + i * 0.4) : (isListening ? 10 * Math.cos(phase * 2 + i * 0.3) : (isThinking ? 8 * Math.sin(phase * 2.5 + i * 0.3) : 3 * Math.sin(phase + i * 0.2)));
      const r = baseRadius + amp;
      const x = centerX + Math.cos(angle) * r;
      const y = centerY + Math.sin(angle) * r;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    ctx.strokeStyle = isSpeaking ? '#ffaa00' : (isListening ? '#00f3ff' : (isThinking ? '#ff007f' : 'rgba(0, 243, 255, 0.5)'));
    ctx.lineWidth = 3;
    ctx.shadowBlur = 15;
    ctx.shadowColor = isSpeaking ? '#ffaa00' : (isThinking ? '#ff007f' : '#00f3ff');
    ctx.stroke();

    // Concentric Orbiting Dots
    const dotCount = 8;
    for (let j = 0; j < dotCount; j++) {
      const dotAngle = phase * 0.8 + (j / dotCount) * Math.PI * 2;
      const dotR = 115;
      const dx = centerX + Math.cos(dotAngle) * dotR;
      const dy = centerY + Math.sin(dotAngle) * dotR;

      ctx.fillStyle = '#64f7ff';
      ctx.beginPath();
      ctx.arc(dx, dy, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    animationFrameId = requestAnimationFrame(render);
  }

  render();
}

/**
 * Neural-sphere hero background: ~150 nodes spread over a Fibonacci sphere
 * with edges between near neighbors, slowly rotating when idle, expanding /
 * retracting with the speech meter while ARIA talks, and turning yellow
 * while thinking. Pure canvas 2D — no dependencies, DPR-aware.
 */
function buildNeuralSphere(count = 330) {
  spherePts = [];
  sphereEdges = [];
  sphereAdj = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    // Organic radial jitter so it reads as a neural web, not a perfect globe.
    const nr = 0.86 + Math.random() * 0.28;
    spherePts.push({
      x: Math.cos(theta) * r * nr, y: y * nr, z: Math.sin(theta) * r * nr,
      tw: Math.random() * Math.PI * 2,          // per-node twinkle phase
      hub: i % 13 === 0                          // sparse glow cores
    });
  }
  // Neighbor pairs are rotation-invariant — compute once, plus an adjacency
  // list so packets can hop neuron to neuron.
  const maxChord = 0.46;
  let edges = 0;
  for (let i = 0; i < count && edges < 1500; i++) {
    for (let j = i + 1; j < count && edges < 1500; j++) {
      const a = spherePts[i], b = spherePts[j];
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      if (dx * dx + dy * dy + dz * dz < maxChord * maxChord) {
        sphereEdges.push([i, j]);
        edges++;
      }
    }
  }
  sphereAdj = Array.from({ length: count }, () => []);
  for (const [i, j] of sphereEdges) {
    sphereAdj[i].push(j);
    sphereAdj[j].push(i);
  }
}

function sizeNeuralCanvas() {
  if (!neuralCanvas || !neuralStage) return false;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.floor(neuralStage.clientWidth * dpr));
  const h = Math.max(1, Math.floor(neuralStage.clientHeight * dpr));
  if (neuralCanvas.width !== w || neuralCanvas.height !== h) {
    neuralCanvas.width = w;
    neuralCanvas.height = h;
  }
  return true;
}

function startNeuralSphere() {
  if (!neuralCanvas || !nctx || !neuralStage) return;
  if (neuralFrameId) {
    cancelAnimationFrame(neuralFrameId);
    neuralFrameId = null;
  }
  const FOCAL = 3.4;
  const BLUE = { r: 102, g: 152, b: 222 }; // dark ocean blue (dim web, bright nodes)
  const YELLOW = { r: 255, g: 198, b: 80 }; // completed thought — the whole web burns yellow
  let t = 0;
  let thinkAlpha = 0;
  let speakEnergy = 0; // smoothed speech drive — fast attack, slow release, never jerky
  // The yellow thought comet (streak, embers, hop impacts) was removed on
  // request — processing no longer sends a shooting star through the web.
  let packets = [];    // cyan data packets — always-on ambient mesh traffic
  let flow = [];       // flowing current streams (orbits of drifting particles)
  let bolts = [];      // jagged lightning arcs jumping across the web
  let boltTimer = 0;
  let boltGlow = 0;    // thunder: ambient light kick from strikes (decays)
  let burst = 0;       // decaying packet-burst driver for state transitions
  let shock = [];      // expanding shockwaves on state transitions
  let flash = 0;       // brief full-frame flash on transitions
  let prevState = 'idle';
  let scan = { active: false, phi: -1.35, next: 320 }; // idle radar pole scan
  let spokes = [];     // nucleus energy filaments (pinned node indices)
  let sonar = [];      // expanding rings while listening
  let bloomCanvas = null;
  let bloomCtx = null;
  let bloomWide = null;   // quarter-res wide-scale bloom (cinematic halo)
  let bloomWideCtx = null;
  let dust = [];

  if (!spherePts.length) buildNeuralSphere();
  if (!dust.length) buildDust();
  sizeNeuralCanvas();
  for (let i = 0; i < 9; i++) spokes.push((Math.random() * spherePts.length) | 0);

  // Click-drag spins the globe like an online globe: direct 1:1 steering
  // while held, flick velocity decaying into inertia on release. Wired once
  // (start re-runs on window visibility changes).
  if (!neuralDragWired && neuralStage) {
    neuralDragWired = true;
    neuralStage.style.cursor = 'grab';
    neuralStage.addEventListener('pointerdown', (e) => {
      neuralDragging = true;
      lastPX = e.clientX;
      lastPY = e.clientY;
      dragVelX = 0;
      dragVelY = 0;
      neuralStage.style.cursor = 'grabbing';
      try { neuralStage.setPointerCapture(e.pointerId); } catch (err) {}
    });
    neuralStage.addEventListener('pointermove', (e) => {
      if (!neuralDragging) return;
      const dx = e.clientX - lastPX, dy = e.clientY - lastPY;
      lastPX = e.clientX;
      lastPY = e.clientY;
      neuralAngle += dx * 0.005;
      userTilt = Math.max(-0.9, Math.min(0.9, userTilt - dy * 0.003));
      dragVelY = dx * 0.005;
      dragVelX = -dy * 0.003;
    });
    const endDrag = () => {
      neuralDragging = false;
      if (neuralStage) neuralStage.style.cursor = 'grab';
    };
    neuralStage.addEventListener('pointerup', endDrag);
    neuralStage.addEventListener('pointercancel', endDrag);
  }

  function buildDust(n = 110) {
    dust = [];
    for (let i = 0; i < n; i++) {
      const z = Math.random(); // pseudo-depth: 0 = far, 1 = near
      dust.push({
        bx: Math.random(), by: Math.random(), z,
        sp: (0.00006 + Math.random() * 0.00022) * (0.5 + z),
        tw: Math.random() * Math.PI * 2,
        sz: (0.6 + Math.random() * 1.4) * (0.6 + z * 0.9)
      });
    }
  }

  // Random neighbor hop for packets, bolts and flow orbits (falls back to
  // staying put on
  // isolated neurons, which shouldn't happen but costs nothing to guard).
  function pickNeighbor(node, avoid) {
    const nb = sphereAdj[node] || [];
    if (!nb.length) return node;
    if (nb.length === 1) return nb[0];
    let next = nb[(Math.random() * nb.length) | 0];
    if (next === avoid) next = nb[((Math.random() * nb.length) | 0)];
    return next;
  }

  function newPulse() {
    let node = (Math.random() * spherePts.length) | 0;
    if (!(sphereAdj[node] || []).length) node = 0;
    return {
      node, next: pickNeighbor(node, -1), t: Math.random(),
      pace: 0.9 + Math.random() * 0.2, trail: [],
      phase: Math.random() * Math.PI * 2
    };
  }

  // Lightning between two distant points on the shell: repeated midpoint
  // displacement with pinned endpoints, re-normalized to the sphere, plus
  // two branch forks stamped onto random midpoints. Points stay in 3D so
  // the whole bolt rotates with the globe during its life.
  function makeBolt() {
    const i = (Math.random() * spherePts.length) | 0;
    let j = (Math.random() * spherePts.length) | 0;
    for (let tries = 0; tries < 8; tries++) {
      if (Math.hypot(spherePts[i].x - spherePts[j].x, spherePts[i].y - spherePts[j].y, spherePts[i].z - spherePts[j].z) > 0.9) break;
      j = (Math.random() * spherePts.length) | 0;
    }
    const a = spherePts[i], b = spherePts[j];
    const segs = 13;
    const pts = [];
    for (let k = 0; k <= segs; k++) {
      const f = k / segs;
      let x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f, z = a.z + (b.z - a.z) * f;
      const env = Math.sin(f * Math.PI) * 0.55; // pinned endpoints, wild middle
      x += (Math.random() - 0.5) * 2 * env;
      y += (Math.random() - 0.5) * 2 * env;
      z += (Math.random() - 0.5) * 2 * env;
      const L = Math.hypot(x, y, z) || 1;
      pts.push({ x: x / L, y: y / L, z: z / L });
    }
    const branches = [];
    const jitFrom = () => (Math.random() * spherePts.length) | 0;
    for (let br = 0; br < 2; br++) {
      if (Math.random() >= 0.75) continue;
      const from = pts[4 + ((Math.random() * (segs - 8)) | 0) || 1];
      const jTarget = jitFrom();
      const bpts = [];
      for (let k = 0; k <= 5; k++) {
        const f = k / 5;
        let x = from.x + (spherePts[jTarget].x - from.x) * f;
        let y = from.y + (spherePts[jTarget].y - from.y) * f;
        let z = from.z + (spherePts[jTarget].z - from.z) * f;
        const env = Math.sin(f * Math.PI) * 0.28;
        x += (Math.random() - 0.5) * 2 * env;
        y += (Math.random() - 0.5) * 2 * env;
        z += (Math.random() - 0.5) * 2 * env;
        const L = Math.hypot(x, y, z) || 1;
        bpts.push({ x: x / L, y: y / L, z: z / L });
      }
      branches.push(bpts);
    }
    return { pts, branches, life: 1, seed: Math.random() * 10 };
  }

  function stateNow() {
    const speaking = voiceEngine ? voiceEngine.isSpeaking : false;
    const listening = voiceEngine ? voiceEngine.isListening : false;
    if (speaking) return 'speaking';
    if (isThinking) return 'thinking';
    if (listening) return 'listening';
    return 'idle';
  }

  function render() {
    neuralFrameId = requestAnimationFrame(render);
    if (document.hidden) return;
    if (homeView && !homeView.classList.contains('active')) return;
    if (!sizeNeuralCanvas()) return;

    const w = neuralCanvas.width, h = neuralCanvas.height;
    const state = stateNow();
    t += 1;

    // Rotation speed per state. Color: the whole web burns yellow only while
    // speaking (thought completed); thinking stays blue with a single pulse.
    const speed = state === 'thinking' ? 0.0105 : (state === 'speaking' ? 0.0055 : (state === 'listening' ? 0.0038 : 0.0022));
    if (!neuralDragging) neuralAngle += speed;
    // Flick inertia: release velocity keeps the globe coasting, decaying out.
    neuralAngle += dragVelY;
    userTilt = Math.max(-0.9, Math.min(0.9, userTilt + dragVelX));
    dragVelX *= 0.94;
    dragVelY *= 0.94;
    if (Math.abs(dragVelX) < 0.00005) dragVelX = 0;
    if (Math.abs(dragVelY) < 0.00005) dragVelY = 0;
    neuralTilt = 0.35 + Math.sin(t * 0.004) * 0.05 + userTilt;
    // Hands-on glow: the web brightens while grabbed or coasting on a flick.
    const flick = Math.min(1, (Math.abs(dragVelX) + Math.abs(dragVelY)) * 60);
    const grabTarget = neuralDragging ? 1 : Math.min(1, flick * 2);
    dragGlow += (grabTarget - dragGlow) * 0.12;
    const grabBoost = 1 + dragGlow * 0.6;
    const target = state === 'speaking' ? YELLOW : BLUE;
    neuralColor.r += (target.r - neuralColor.r) * 0.06;
    neuralColor.g += (target.g - neuralColor.g) * 0.06;
    neuralColor.b += (target.b - neuralColor.b) * 0.06;
    const boost = state === 'idle' ? 0.7 : (state === 'speaking' ? 1.4 : 1);

    // Smooth speech drive: fast attack on voice energy, slow release — the
    // raw meter jumps frame to frame, this never does.
    const rawDrive = (voiceEngine && voiceEngine.isSpeaking) ? (0.35 + 0.65 * Math.min(1, meterLevel)) : 0;
    speakEnergy += (rawDrive - speakEnergy) * (rawDrive > speakEnergy ? 0.25 : 0.06);

    // Calm global breathing only; speech moves the neurons themselves below.
    const breathe = 1 + Math.sin(t * 0.02) * 0.022;

    const R = Math.min(w, h) * 0.30 * breathe;
    const cx = w / 2, cy = h / 2 + h * 0.02;
    const cosA = Math.cos(neuralAngle), sinA = Math.sin(neuralAngle);
    const cosT = Math.cos(neuralTilt), sinT = Math.sin(neuralTilt);

    // State-change theatre: a flash + expanding shockwave + a burst of
    // packets punctuate every transition into thinking or speaking.
    if (state !== prevState) {
      if (state === 'speaking' || state === 'thinking') {
        shock.push({ r: R * 0.9, a: 0.5, lw: 3 });
        flash = Math.max(flash, state === 'thinking' ? 0.22 : 0.3);
        burst = 1;
      }
      prevState = state;
    }

    // Project all nodes once. The speech wave is keyed to each neuron's
    // shell radius and latitude — neighbors share nearly the same phase,
    // so the web swells and settles coherently instead of shearing sideways.
    const proj = new Array(spherePts.length);
    for (let i = 0; i < spherePts.length; i++) {
      const p = spherePts[i];
      const r0 = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      const dd = 1 + speakEnergy * 0.10 * Math.sin(t * 0.09 - r0 * 6.0)
                   + speakEnergy * 0.03 * Math.sin(t * 0.05 + p.y * 2.0);
      const px = p.x * dd, py = p.y * dd, pz = p.z * dd;
      const x1 = px * cosA + pz * sinA;
      const z1 = -px * sinA + pz * cosA;
      const y1 = py * cosT - z1 * sinT;
      const z2 = py * sinT + z1 * cosT;
      const s = FOCAL / (FOCAL - z2);
      proj[i] = { x: cx + x1 * R * s, y: cy + y1 * R * s, s, z: z2, tw: p.tw, hub: p.hub, lat: p.y };
    }

    // Thinking engages the web through thinkAlpha (scene brightness below
    // lifts slightly). The yellow thought comet was removed on request —
    // processing shows no shooting star.
    thinkAlpha += ((state === 'thinking' ? 1 : 0) - thinkAlpha) * 0.07;

    // Ambient mesh traffic: cyan data packets hop the wiring constantly, at a
    // density set by the mood (listening = busy airwaves, speaking = flood).
    // Transitions ride a decaying `burst` so extra packets live a second.
    if (burst > 0.01) burst *= 0.9; else burst = 0;
    const wantPackets = (state === 'speaking' ? 14 : (state === 'listening' ? 8 : (state === 'thinking' ? 5 : 4)))
      + Math.round(10 * burst);
    const packetSpeed = (state === 'speaking' ? 2.1 : 1);
    while (packets.length < wantPackets) packets.push(newPulse());
    if (packets.length > wantPackets) packets.length = wantPackets;
    for (const pk of packets) {
      const a0 = proj[pk.node], b0 = proj[pk.next];
      const edgeLen = Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y));
      pk.t += ((w / 16000) * pk.pace * packetSpeed) / edgeLen + 0.004;
      if (pk.t >= 1) {
        pk.node = pk.next;
        pk.next = pickNeighbor(pk.node, pk.next);
        pk.t = 0;
      }
      const a = proj[pk.node], b = proj[pk.next];
      pk.hx = a.x + (b.x - a.x) * pk.t;
      pk.hy = a.y + (b.y - a.y) * pk.t;
      pk.s = (a.s + b.s) / 2;
      pk.trail.push({ x: pk.hx, y: pk.hy });
      if (pk.trail.length > 10) pk.trail.shift();
    }

    // Lightning arcs: thinking crackles hard, talking at peaks, and even
    // idle throws out a rare faint distant crack. Every strike kicks the
    // ambient light of the scene — the thunder answering itself.
    if (--boltTimer <= 0) {
      if (state === 'thinking' || speakEnergy > 0.45) {
        boltTimer = (state === 'thinking' ? 16 : 34) + ((Math.random() * 40) | 0);
        bolts.push(makeBolt());
        boltGlow = Math.min(1, boltGlow + 0.4);
        if (bolts.length > 4) bolts.shift();
      } else if (state === 'idle' && Math.random() < 0.22) {
        boltTimer = 260 + ((Math.random() * 240) | 0);
        const dimBolt = makeBolt();
        dimBolt.dim = true;
        bolts.push(dimBolt);
        boltGlow = Math.min(1, boltGlow + 0.18);
        if (bolts.length > 4) bolts.shift();
      } else {
        boltTimer = 60;
      }
    }
    for (const b of bolts) b.life -= 0.08;
    bolts = bolts.filter(b => b.life > 0);
    boltGlow *= 0.90;

    nctx.clearRect(0, 0, w, h);
    const cr = Math.round(neuralColor.r), cg = Math.round(neuralColor.g), cb = Math.round(neuralColor.b);

    // Back glow disc.
    const glow = nctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.5);
    glow.addColorStop(0, `rgba(${cr},${cg},${cb},${Math.min(1, 0.08 * boost + speakEnergy * 0.12 + dragGlow * 0.1 + boltGlow * 0.10).toFixed(3)})`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    nctx.fillStyle = glow;
    nctx.fillRect(cx - R * 1.5, cy - R * 1.5, R * 3, R * 3);

    // The nucleus: a white-hot core wrapped in a colored corona of rotating
    // filaments — breathes with speech, runs amber when engaged.
    const nR = R * (0.15 + 0.025 * Math.sin(t * 0.02) + speakEnergy * 0.07);
    const warmCore = speakEnergy > 0.12 || state === 'thinking';
    nctx.save();
    nctx.globalCompositeOperation = 'lighter';
    const nGrad = nctx.createRadialGradient(cx, cy, 0, cx, cy, nR * 2.4);
    nGrad.addColorStop(0, `rgba(255,252,244,${Math.min(1, 0.5 + speakEnergy * 0.5).toFixed(3)})`);
    nGrad.addColorStop(0.28, warmCore
      ? `rgba(255,190,110,${(0.5 + 0.4 * Math.min(1, speakEnergy * 2)).toFixed(3)})`
      : `rgba(140,205,255,0.55)`);
    nGrad.addColorStop(1, 'rgba(20,30,60,0)');
    nctx.fillStyle = nGrad;
    nctx.beginPath();
    nctx.arc(cx, cy, nR * 2.4, 0, Math.PI * 2);
    nctx.fill();
    for (let cs = 0; cs < 5; cs++) {
      const ca = t * (0.008 + cs * 0.004) + cs * 1.7;
      const cRad = nR * (1.15 + cs * 0.16);
      const cLen = 0.7 + cs * 0.35 + Math.sin(t * 0.03 + cs * 2.1) * 0.35;
      nctx.strokeStyle = warmCore
        ? `rgba(255,180,105,${(0.30 - cs * 0.045).toFixed(3)})`
        : `rgba(120,190,255,${(0.26 - cs * 0.04).toFixed(3)})`;
      nctx.lineWidth = Math.max(1, w / 900);
      nctx.beginPath();
      nctx.arc(cx, cy, cRad, ca, ca + cLen);
      nctx.stroke();
    }
    // Rosette: twelve thin energy rays sweeping slowly around the nucleus —
    // the core quietly radiating structured light.
    for (let rs = 0; rs < 12; rs++) {
      const ra = t * 0.006 + rs * Math.PI / 6;
      const rl = nR * (1.9 + 0.7 * Math.sin(t * 0.017 + rs * 1.31));
      const rf = 0.5 + 0.5 * Math.sin(t * 0.9 + rs * 2.4); // per-ray crackle
      const rg = nctx.createLinearGradient(
        cx + Math.cos(ra) * nR * 0.8, cy + Math.sin(ra) * nR * 0.8,
        cx + Math.cos(ra) * rl, cy + Math.sin(ra) * rl
      );
      rg.addColorStop(0, warmCore
        ? `rgba(255,200,120,${(0.10 + 0.05 * rf).toFixed(3)})`
        : `rgba(120,190,255,${(0.09 + 0.05 * rf).toFixed(3)})`);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      nctx.strokeStyle = rg;
      nctx.lineWidth = Math.max(0.6, w / 1400);
      nctx.beginPath();
      nctx.moveTo(cx + Math.cos(ra) * nR * 0.8, cy + Math.sin(ra) * nR * 0.8);
      nctx.lineTo(cx + Math.cos(ra) * rl, cy + Math.sin(ra) * rl);
      nctx.stroke();
    }
    // Electric feeding arcs: the nucleus feeds pinned neurons by crackling
    // lightning — jagged midpoints re-randomized every frame — instead of
    // steady hairlines. Only front-facing spokes.
    for (const nd of spokes) {
      const sp = proj[nd];
      if (!sp || sp.s < 0.78) continue;
      const flick2 = 0.6 + 0.4 * Math.sin(t * 0.31 + nd * 2.7);
      const sgrad = nctx.createLinearGradient(cx, cy, sp.x, sp.y);
      sgrad.addColorStop(0, `rgba(255,235,190,${(0.11 * flick2).toFixed(3)})`);
      sgrad.addColorStop(1, `rgba(${cr},${cg},${cb},${(0.05 * flick2).toFixed(3)})`);
      nctx.strokeStyle = sgrad;
      nctx.lineWidth = Math.max(0.7, w / 1500);
      nctx.beginPath();
      nctx.moveTo(cx, cy);
      for (let q2 = 1; q2 < 4; q2++) {
        const f2 = q2 / 4;
        const ex = cx + (sp.x - cx) * f2 + (Math.random() - 0.5) * (w / 90) * Math.sin(f2 * Math.PI);
        const ey = cy + (sp.y - cy) * f2 + (Math.random() - 0.5) * (w / 90) * Math.sin(f2 * Math.PI);
        nctx.lineTo(ex, ey);
      }
      nctx.lineTo(sp.x, sp.y);
      nctx.stroke();
    }
    nctx.restore();

    // Mantle structure: faint latitude bands + a detached outer orbit ring,
    // both breathing slowly — the planet-scale frame from the references.
    nctx.lineWidth = Math.max(0.5, w / 2200);
    for (let ring = 0; ring < 5; ring++) {
      const phi = (-0.75 + ring * 0.375) + Math.sin(t * 0.003 + ring) * 0.02;
      const ry = Math.cos(phi), rr = Math.sin(phi);
      nctx.beginPath();
      for (let k = 0; k <= 72; k++) {
        const ang = (k / 72) * Math.PI * 2;
        const x0 = rr * Math.cos(ang), z0 = rr * Math.sin(ang);
        const x1 = x0 * cosA + z0 * sinA;
        const z1 = -x0 * sinA + z0 * cosA;
        const y1 = ry * cosT - z1 * sinT;
        if (k === 0) nctx.moveTo(cx + x1 * R, cy + y1 * R);
        else nctx.lineTo(cx + x1 * R, cy + y1 * R);
      }
      nctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.045 + 0.02 * boost).toFixed(3)})`;
      nctx.stroke();
    }
    // Outer orbit halo — a detached ring drifting around the whole core.
    nctx.beginPath();
    const orbR = R * 1.34 * (1 + Math.sin(t * 0.01) * 0.015);
    for (let k = 0; k <= 96; k++) {
      const ang = (k / 96) * Math.PI * 2;
      const x0 = Math.cos(ang), z0 = Math.sin(ang);
      const x1 = x0 * cosA + z0 * sinA;
      const z1 = -x0 * sinA + z0 * cosA;
      const y1 = -z1 * sinT;
      if (k === 0) nctx.moveTo(cx + x1 * orbR, cy + y1 * orbR);
      else nctx.lineTo(cx + x1 * orbR, cy + y1 * orbR);
    }
    nctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.10 + speakEnergy * 0.08).toFixed(3)})`;
    nctx.stroke();

    // Idle radar scan: a bright latitude band sweeps pole to pole every
    // once in a while when the core is idle, waking nodes it passes.
    if (state === 'idle' && !scan.active) {
      if (--scan.next <= 0) { scan.active = true; scan.phi = -1.35; }
    }
    if (scan.active) {
      scan.phi += 0.011;
      if (scan.phi > 1.35) {
        scan.active = false;
        scan.next = 560 + ((Math.random() * 480) | 0);
      } else {
        const sry = Math.cos(scan.phi), srr = Math.sin(scan.phi);
        nctx.beginPath();
        for (let k = 0; k <= 72; k++) {
          const ang = (k / 72) * Math.PI * 2;
          const x0 = srr * Math.cos(ang) * 1.02, z0 = srr * Math.sin(ang) * 1.02;
          const x1 = x0 * cosA + z0 * sinA;
          const z1 = -x0 * sinA + z0 * cosA;
          const y1 = sry * cosT - z1 * sinT;
          if (k === 0) nctx.moveTo(cx + x1 * R, cy + y1 * R);
          else nctx.lineTo(cx + x1 * R, cy + y1 * R);
        }
        nctx.strokeStyle = `rgba(190,225,255,${(0.10 + 0.06 * Math.abs(Math.sin(t * 0.2))).toFixed(3)})`;
        nctx.lineWidth = Math.max(0.8, w / 1400);
        nctx.stroke();
      }
    }

    // Ambient drifting dust motes — parallax starfield: near motes are
    // bigger, brighter, faster; far motes whisper.
    for (let d = 0; d < dust.length; d++) {
      const m = dust[d];
      const dx = ((m.bx + t * m.sp) % 1) * w;
      const dy = (m.by * h + Math.sin(t * 0.008 + m.tw) * h * 0.01 + h) % h;
      const twD = ((0.09 + 0.10 * m.z) * (0.55 + 0.45 * Math.sin(t * 0.03 + m.tw))).toFixed(3);
      nctx.fillStyle = `rgba(160,190,235,${twD})`;
      const msz = m.sz * (0.7 + m.z);
      nctx.fillRect(dx, dy, msz, msz);
    }

    // NOTE: static edge wireframe intentionally not drawn — the connection
    // lines were removed, leaving the nodes, flows and traffic as the shape.
    // Edge/adjacency data is still computed: pulses, packets and bolts hop
    // node-to-node through it.

    // Flowing current streams: 300 particles advected in stacked latitude
    // lanes around the shell — the "swirling atlas" layer from the refs.
    // Warm embers (every 17th) catch the speak/think emphasis.
    if (!flow.length) {
      for (let i = 0; i < 420; i++) {
        flow.push({
          lane: (i % 6) * 0.44 - 1.05,
          u: Math.random() * Math.PI * 2,
          r: 0.82 + Math.random() * 0.2,
          sp: (0.0025 + Math.random() * 0.0045) * (i % 2 ? 1 : -1),
          ph: Math.random() * Math.PI * 2,
          warm: i % 17 === 0,
          trail: []
        });
      }
    }
    const flowBoost = 1 + speakEnergy * 1.4;
    nctx.save();
    nctx.globalCompositeOperation = 'lighter';
    nctx.lineCap = 'round';
    for (const q of flow) {
      q.u += q.sp * flowBoost * (state === 'thinking' ? 1.6 : 1);
      const v = q.lane * 0.45 + Math.sin(t * 0.004 * 2 + q.ph) * 0.08;
      const cv = Math.cos(v), sv = Math.sin(v);
      const x0 = q.r * cv * Math.cos(q.u), z0 = q.r * cv * Math.sin(q.u);
      const x1 = x0 * cosA + z0 * sinA;
      const z1 = -x0 * sinA + z0 * cosA;
      const y1 = q.r * sv * cosT - z1 * sinT;
      const z2 = q.r * sv * sinT + z1 * cosT;
      const s = FOCAL / (FOCAL - z2);
      q.trail.push({ x: cx + x1 * R * s, y: cy + y1 * R * s });
      if (q.trail.length > 7) q.trail.shift();
      const depth = Math.max(0, Math.min(1, (s - 0.72) / 0.6));
      const a = (0.05 + 0.40 * depth) * (q.warm ? 1.2 : 1) * Math.min(1.6, 0.55 + 0.45 * boost);
      if (a < 0.02 || q.trail.length < 2) continue;
      nctx.strokeStyle = q.warm
        ? `rgba(255,168,92,${(a * 0.8).toFixed(3)})`
        : `rgba(${Math.round(60 + 30 * depth)},${Math.round(185 + 45 * depth)},255,${a.toFixed(3)})`;
      nctx.lineWidth = Math.max(0.7, (1 + depth * 1.4) * (w / 960));
      nctx.beginPath();
      nctx.moveTo(q.trail[0].x, q.trail[0].y);
      for (let k = 1; k < q.trail.length; k++) nctx.lineTo(q.trail[k].x, q.trail[k].y);
      nctx.stroke();
    }
    nctx.restore();

    // Neurons: defined glowing dots — layered additive halo, a saturated
    // color rim, and a crisp white-hot center (bloom amplifies all of it).
    nctx.save();
    nctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < proj.length; i++) {
      const p = proj[i];
      const depth = Math.max(0, Math.min(1, (p.s - 0.72) / 0.6));
      const jitter = 0.6 + 0.7 * (Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1);
      const coreR = (0.6 + depth * 1.2) * jitter * (w / 1600 + 0.5);
      // Each neuron twinkles on its own clock; speaking sweeps heat waves
      // across the web (nodes tint warm by latitude band in time with the
      // swell the edges already ride).
      const scanK = scan.active
        ? Math.exp(-Math.pow(Math.acos(Math.max(-1, Math.min(1, p.lat))) - scan.phi, 2) / 0.02)
        : 0;
      const twinkle = (0.78 + 0.32 * Math.sin(t * 0.05 + p.tw)) * (1 + scanK * 1.6);
      const heat = Math.max(0, speakEnergy * (0.5 + 0.5 * Math.sin(t * 0.09 + p.lat * 3)));
      let hr = cr, hg = cg, hb = cb;
      let cwr = 235, cwg = 244, cwb = 255;
      // Speaking heat: cores lean amber in sync with the radio-wave swell.
      if (heat > 0.02) {
        const wl = Math.max(0, Math.min(1, heat));
        cwr = Math.round(235 + 20 * wl);
        cwg = Math.round(244 - 70 * wl);
        cwb = Math.round(255 - 150 * wl);
      }
      const alphaBase = Math.min(1, (0.55 + depth * 0.45) * twinkle * (1 + boltGlow * 0.35));
      const hubScale = p.hub ? 1.5 : 1;
      // Two-step fake halo (additive): wide whisper + tight intimate glow.
      nctx.fillStyle = `rgba(${hr},${hg},${hb},${(0.10 * alphaBase * hubScale).toFixed(3)})`;
      nctx.beginPath();
      nctx.arc(p.x, p.y, coreR * 3.4 * hubScale, 0, Math.PI * 2);
      nctx.fill();
      nctx.fillStyle = `rgba(${hr},${hg},${hb},${(0.24 * alphaBase * hubScale).toFixed(3)})`;
      nctx.beginPath();
      nctx.arc(p.x, p.y, coreR * 1.9 * hubScale, 0, Math.PI * 2);
      nctx.fill();
      // Saturated color rim — this is the "dot" the eye reads.
      nctx.fillStyle = `rgba(${hr},${hg},${hb},${Math.min(1, 0.9 * alphaBase).toFixed(3)})`;
      nctx.beginPath();
      nctx.arc(p.x, p.y, coreR * hubScale, 0, Math.PI * 2);
      nctx.fill();
      // Crisp white-hot center — the definition.
      nctx.fillStyle = `rgba(${cwr},${cwg},${cwb},${Math.min(1, (0.85 + depth * 0.15) * twinkle).toFixed(3)})`;
      nctx.beginPath();
      nctx.arc(p.x, p.y, coreR * 0.55 * hubScale, 0, Math.PI * 2);
      nctx.fill();
    }
    nctx.restore();

    // (The yellow thought comet's trail/embers/ripple pass was removed on
    // request — the ambient cyan packets below carry all mesh traffic.)

    // Ambient packets: small cyan comets with whisper trails, busiest when
    // the web is engaged (speaking floods the wiring).
    nctx.save();
    nctx.globalCompositeOperation = 'lighter';
    nctx.lineCap = 'round';
    for (const pk of packets) {
      const pt = pk.trail;
      for (let k = 1; k < pt.length; k++) {
        const frac = k / pt.length;
        const alpha = frac * 0.30 * (0.5 + 0.5 * (pk.s || 0.8));
        nctx.strokeStyle = `rgba(96,210,255,${alpha.toFixed(3)})`;
        nctx.lineWidth = Math.max(0.8, frac * w / 900);
        nctx.beginPath();
        nctx.moveTo(pt[k - 1].x, pt[k - 1].y);
        nctx.lineTo(pt[k].x, pt[k].y);
        nctx.stroke();
      }
      const hr = Math.max(1.2, w / 700);
      const halo = nctx.createRadialGradient(pk.hx, pk.hy, 0, pk.hx, pk.hy, hr * 5);
      halo.addColorStop(0, 'rgba(190,235,255,0.55)');
      halo.addColorStop(1, 'rgba(96,210,255,0)');
      nctx.fillStyle = halo;
      nctx.beginPath();
      nctx.arc(pk.hx, pk.hy, hr * 5, 0, Math.PI * 2);
      nctx.fill();
      nctx.fillStyle = 'rgba(235,250,255,0.85)';
      nctx.beginPath();
      nctx.arc(pk.hx, pk.hy, hr * 0.7, 0, Math.PI * 2);
      nctx.fill();
    }
    nctx.restore();

    // Lightning bolts over the web: re-jagged EVERY frame so the arcs
    // crackle like raw electricity, white-hot core under colored glow,
    // with branch forks. Idle bolts are faint distant cracks.
    nctx.save();
    nctx.globalCompositeOperation = 'lighter';
    nctx.lineCap = 'round';
    nctx.lineJoin = 'round';
    const warmBolt = speakEnergy > 0.4;
    for (const b of bolts) {
      const dimK = b.dim ? 0.5 : 1;
      const flick = b.life * (0.6 + 0.4 * Math.sin(t * 0.83 + b.seed * 7)) * dimK;
      if (flick <= 0.02) continue;
      const drawPts = (arr, jitterW) => arr.map((q, k2) => {
        const env = Math.sin((k2 / (arr.length - 1)) * Math.PI);
        const x1 = q.x * cosA + q.z * sinA;
        const z1l = -q.x * sinA + q.z * cosA;
        const y1 = q.y * cosT - z1l * sinT;
        const z2 = q.y * sinT + z1l * cosT;
        const sc = FOCAL / (FOCAL - z2 * breathe);
        return {
          x: cx + x1 * R * sc + (Math.random() - 0.5) * jitterW * env,
          y: cy + y1 * R * sc + (Math.random() - 0.5) * jitterW * env
        };
      });
      const strokePts = (arr, color, lw) => {
        nctx.strokeStyle = color;
        nctx.lineWidth = lw;
        nctx.beginPath();
        nctx.moveTo(arr[0].x, arr[0].y);
        for (let k = 1; k < arr.length; k++) nctx.lineTo(arr[k].x, arr[k].y);
        nctx.stroke();
      };
      const main = drawPts(b.pts, w / 240);
      const gcol = warmBolt ? '255,225,170' : '160,220,255';
      // Wide sky-wash glow, tight body, white-hot fuzzy core.
      strokePts(main, `rgba(${gcol},${(flick * 0.12).toFixed(3)})`, Math.max(3, w / 110));
      strokePts(main, `rgba(${gcol},${(flick * 0.30).toFixed(3)})`, Math.max(1.6, w / 300));
      strokePts(main, `rgba(255,252,245,${(flick * 0.85).toFixed(3)})`, Math.max(0.8, w / 700));
      for (const br of (b.branches || [])) {
        strokePts(drawPts(br, w / 300), `rgba(${gcol},${(flick * 0.22).toFixed(3)})`, Math.max(0.7, w / 500));
      }
    }
    nctx.restore();

    // Sonar rings: the core emits soft expanding rings while it listens.
    if (state === 'listening' && t % 130 === 0) {
      sonar.push({ r: R * 0.6, a: 0.5 });
    }
    for (let s = sonar.length - 1; s >= 0; s--) {
      const sg = sonar[s];
      sg.r += R * 0.02;
      sg.a *= 0.972;
      if (sg.a < 0.02) { sonar.splice(s, 1); continue; }
      nctx.strokeStyle = `rgba(${cr},${cg},${cb},${sg.a.toFixed(3)})`;
      nctx.lineWidth = Math.max(0.8, w / 1000);
      nctx.beginPath();
      nctx.arc(cx, cy, sg.r, 0, Math.PI * 2);
      nctx.stroke();
    }

    // Transition shockwaves: a bright pressure front with a cool trailing
    // echo ring, blasted outward on every state flip into thinking/speaking.
    for (let s = shock.length - 1; s >= 0; s--) {
      const sk = shock[s];
      sk.r += (R * 2.4 - sk.r) * 0.055;
      sk.a *= 0.94;
      if (sk.a < 0.02) { shock.splice(s, 1); continue; }
      nctx.strokeStyle = `rgba(255,240,215,${(sk.a * 0.8).toFixed(3)})`;
      nctx.lineWidth = Math.max(1, sk.lw * (R / 300) * 0.7);
      nctx.beginPath();
      nctx.arc(cx, cy, sk.r, 0, Math.PI * 2);
      nctx.stroke();
      nctx.strokeStyle = `rgba(140,190,255,${(sk.a * 0.5).toFixed(3)})`;
      nctx.lineWidth = Math.max(1, sk.lw * (R / 300) * 1.6);
      nctx.beginPath();
      nctx.arc(cx, cy, sk.r * 1.07, 0, Math.PI * 2);
      nctx.stroke();
    }

    // Transition flash: one near-invisible full-frame wash, decaying fast.
    if (flash > 0.01) {
      nctx.fillStyle = `rgba(180,220,255,${(flash * 0.16).toFixed(3)})`;
      nctx.fillRect(0, 0, w, h);
      flash *= 0.86;
    }

    // Thunder wash: every strike briefly lifts the whole sky — the storm
    // answering itself, even at idle.
    if (boltGlow > 0.02) {
      nctx.fillStyle = `rgba(210,235,255,${(boltGlow * 0.05).toFixed(3)})`;
      nctx.fillRect(0, 0, w, h);
    }

    // Focus vignette: darken the outer frame so the core pops forward.
    const vg = nctx.createRadialGradient(cx, cy, R * 1.15, cx, cy, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(1,3,9,0.42)');
    nctx.fillStyle = vg;
    nctx.fillRect(0, 0, w, h);

    // Bloom: a half-resolution blurred copy of the frame composited back
    // additively — glow halos on every bright element, cheap on GPU.
    if (!bloomCanvas) {
      bloomCanvas = document.createElement('canvas');
      bloomCtx = bloomCanvas.getContext('2d');
    }
    const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    if (bloomCanvas.width !== bw || bloomCanvas.height !== bh) {
      bloomCanvas.width = bw;
      bloomCanvas.height = bh;
    }
    bloomCtx.clearRect(0, 0, bw, bh);
    bloomCtx.drawImage(neuralCanvas, 0, 0, bw, bh);
    nctx.save();
    nctx.globalCompositeOperation = 'lighter';
    nctx.filter = 'blur(10px)';
    nctx.globalAlpha = 0.55 + speakEnergy * 0.15;
    nctx.drawImage(bloomCanvas, 0, 0, w, h);
    nctx.restore();
    nctx.filter = 'none';

    // Wide bloom: a quarter-res pass at a much larger blur is composited
    // under/over the tight one — layered tight+wide = cinematic halo depth.
    if (!bloomWide) {
      bloomWide = document.createElement('canvas');
      bloomWideCtx = bloomWide.getContext('2d');
    }
    const w2 = Math.max(1, w >> 2), h2 = Math.max(1, h >> 2);
    if (bloomWide.width !== w2 || bloomWide.height !== h2) {
      bloomWide.width = w2;
      bloomWide.height = h2;
    }
    bloomWideCtx.clearRect(0, 0, w2, h2);
    bloomWideCtx.drawImage(neuralCanvas, 0, 0, w2, h2);
    nctx.save();
    nctx.globalCompositeOperation = 'lighter';
    nctx.filter = 'blur(18px)';
    nctx.globalAlpha = 0.32 + speakEnergy * 0.1 + thinkAlpha * 0.08;
    nctx.drawImage(bloomWide, 0, 0, w, h);
    nctx.restore();
    nctx.filter = 'none';

  }

  render();
}

/**
 * Renders the speech-output meter bars from the current meterLevel (0..1).
 */
function renderMeter() {
  const litCount = Math.round(meterLevel * speechMeterBars.length);
  speechMeterBars.forEach((bar, i) => {
    bar.classList.toggle('lit', i < litCount);
  });
}

/**
 * Decays meterLevel toward 0 each frame, so a pulse from one word fades out
 * smoothly instead of vanishing instantly at the next boundary event.
 */
function decayMeterLoop() {
  meterLevel = Math.max(0, meterLevel - 0.05);
  renderMeter();
  if (meterLevel > 0) {
    meterDecayFrameId = requestAnimationFrame(decayMeterLoop);
  } else {
    meterDecayFrameId = null;
  }
}

/**
 * Pulses the meter to at least `intensity` (0..1), called on each spoken
 * word boundary from VoiceEngine's onSpeechMeter callback.
 */
function pulseMeter(intensity) {
  meterLevel = Math.max(meterLevel, intensity);
  renderMeter();
  if (!meterDecayFrameId) {
    meterDecayFrameId = requestAnimationFrame(decayMeterLoop);
  }
}

/**
 * Shows/hides the meter row per the soundMeterEnabled setting.
 */
function applySoundMeterVisibility(enabled) {
  if (!speechMeter) return;
  speechMeter.classList.toggle('hidden', !enabled);
}

/**
 * Wires up the Settings modal: open/close, loading current values on open,
 * saving on change, and applying live effects (voice re-pick, meter
 * visibility, API key hot-update) without requiring a reload.
 */
function initSettingsPanel() {
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  const userNameInput = document.getElementById('userNameInput');
  const openTabToggle = document.getElementById('openTabToggle');
  const voiceGenderMale = document.getElementById('voiceGenderMale');
  const voiceGenderFemale = document.getElementById('voiceGenderFemale');
  const soundMeterToggle = document.getElementById('soundMeterToggle');
  const useGroqToggle = document.getElementById('useGroqToggle');
  const useHermesToggle = document.getElementById('useHermesToggle');
  const openrouterKeyInput = document.getElementById('openrouterKeyInput');
  const groqKeyInput = document.getElementById('groqKeyInput');
  const geminiKeyInput = document.getElementById('geminiKeyInput');
  const deepgramKeyInput = document.getElementById('deepgramKeyInput');
  const elevenlabsKeyInput = document.getElementById('elevenlabsKeyInput');
  const elevenlabsVoiceIdInput = document.getElementById('elevenlabsVoiceIdInput');
  const wolframKeyInput = document.getElementById('wolframKeyInput');
  const spotifyClientIdInput = document.getElementById('spotifyClientIdInput');
  const spotifyClientSecretInput = document.getElementById('spotifyClientSecretInput');
  const googleClientIdInput = document.getElementById('googleClientIdInput');
  const googleClientSecretInput = document.getElementById('googleClientSecretInput');
  const apiKeysSaveBtn = document.getElementById('apiKeysSaveBtn');
  const apiKeysStatus = document.getElementById('apiKeysStatus');

  if (!settingsBtn || !settingsModal) return;

  const settings = loadSettings();
  if (userNameInput) {
    userNameInput.value = settings.userName || '';
    userNameInput.addEventListener('change', () => {
      saveSettings({ userName: userNameInput.value.trim() });
      applyUserIdentity();
    });
  }
  if (openTabToggle) openTabToggle.checked = settings.openTabOnSearch;
  if (voiceGenderMale) voiceGenderMale.checked = settings.voiceGender === 'male';
  if (voiceGenderFemale) voiceGenderFemale.checked = settings.voiceGender === 'female';
  if (soundMeterToggle) soundMeterToggle.checked = settings.soundMeterEnabled;
  if (useGroqToggle) useGroqToggle.checked = settings.useGroq;
  if (useHermesToggle) useHermesToggle.checked = settings.useHermes;
  applySoundMeterVisibility(settings.soundMeterEnabled);

  const keyPreview = (value) =>
    value && value.length > 4 ? `${'•'.repeat(Math.min(12, value.length - 4))}${value.slice(-4)}` : value;
  const keyPlaceholder = (name, value) =>
    value ? `${name}: ${keyPreview(value)} (saved)` : `${name}`;

  if (openrouterKeyInput) {
    openrouterKeyInput.placeholder = keyPlaceholder('OpenRouter API Key', localStorage.getItem('jarvis_openrouter_api_key'));
  }
  if (groqKeyInput) {
    groqKeyInput.placeholder = keyPlaceholder('Groq API Key', localStorage.getItem('jarvis_groq_api_key'));
  }
  if (geminiKeyInput) {
    geminiKeyInput.placeholder = keyPlaceholder('Gemini API Key', localStorage.getItem('jarvis_gemini_api_key'));
  }
  if (deepgramKeyInput) {
    deepgramKeyInput.placeholder = keyPlaceholder('Deepgram API Key', localStorage.getItem('jarvis_deepgram_api_key'));
  }
  if (elevenlabsKeyInput) {
    elevenlabsKeyInput.placeholder = keyPlaceholder('ElevenLabs API Key', localStorage.getItem('jarvis_elevenlabs_api_key'));
  }
  if (elevenlabsVoiceIdInput) {
    const savedVoiceId = localStorage.getItem('jarvis_elevenlabs_voice_id');
    const savedDefault = localStorage.getItem('jarvis_elevenlabs_api_key')
      ? (loadSettings().voiceGender === 'female' ? 'Rachel/21m00Tcm4TlvDq8ikWAM' : 'Adam/pNInz6obpgDQGcFmaJgB')
      : 'Rachel/Adam (no key yet)';
    elevenlabsVoiceIdInput.placeholder = savedVoiceId
      ? `ElevenLabs Voice ID: ${savedVoiceId} (saved)`
      : `ElevenLabs Voice ID (${savedDefault})`;
  }
  if (wolframKeyInput) {
    wolframKeyInput.placeholder = keyPlaceholder('WolframAlpha AppID', localStorage.getItem('jarvis_wolfram_app_id'));
  }
  if (spotifyClientIdInput) {
    spotifyClientIdInput.placeholder = keyPlaceholder('Spotify Client ID', localStorage.getItem('jarvis_spotify_client_id'));
  }
  if (spotifyClientSecretInput) {
    spotifyClientSecretInput.placeholder = keyPlaceholder('Spotify Client Secret', localStorage.getItem('jarvis_spotify_client_secret'));
  }
  if (googleClientIdInput) {
    googleClientIdInput.placeholder = keyPlaceholder('Google Client ID', localStorage.getItem('jarvis_google_client_id'));
  }
  if (googleClientSecretInput) {
    googleClientSecretInput.placeholder = keyPlaceholder('Google Client Secret', localStorage.getItem('jarvis_google_client_secret'));
  }

  const openModal = () => settingsModal.classList.add('open');
  const closeModal = () => settingsModal.classList.remove('open');

  settingsBtn.addEventListener('click', openModal);
  if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeModal);
  if (settingsBackdrop) settingsBackdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal.classList.contains('open')) closeModal();
  });

  if (openTabToggle) {
    openTabToggle.addEventListener('change', () => {
      saveSettings({ openTabOnSearch: openTabToggle.checked });
    });
  }

  const applyVoiceGender = (gender) => {
    saveSettings({ voiceGender: gender });
    if (voiceEngine) voiceEngine.applyVoicePreference();
  };
  if (voiceGenderMale) {
    voiceGenderMale.addEventListener('change', () => {
      if (voiceGenderMale.checked) applyVoiceGender('male');
    });
  }
  if (voiceGenderFemale) {
    voiceGenderFemale.addEventListener('change', () => {
      if (voiceGenderFemale.checked) applyVoiceGender('female');
    });
  }

  if (soundMeterToggle) {
    soundMeterToggle.addEventListener('change', () => {
      saveSettings({ soundMeterEnabled: soundMeterToggle.checked });
      applySoundMeterVisibility(soundMeterToggle.checked);
    });
  }

  if (useGroqToggle) {
    useGroqToggle.addEventListener('change', () => {
      saveSettings({ useGroq: useGroqToggle.checked });
    });
  }

  if (useHermesToggle) {
    useHermesToggle.addEventListener('change', () => {
      saveSettings({ useHermes: useHermesToggle.checked });
    });
  }

  if (apiKeysSaveBtn) {
    apiKeysSaveBtn.addEventListener('click', () => {
      const openrouterKey = openrouterKeyInput ? openrouterKeyInput.value.trim() : '';
      const groqKey = groqKeyInput ? groqKeyInput.value.trim() : '';
      const geminiKey = geminiKeyInput ? geminiKeyInput.value.trim() : '';
      const deepgramKey = deepgramKeyInput ? deepgramKeyInput.value.trim() : '';
      const elevenlabsKey = elevenlabsKeyInput ? elevenlabsKeyInput.value.trim() : '';
      const elevenlabsVoiceId = elevenlabsVoiceIdInput ? elevenlabsVoiceIdInput.value.trim() : '';
      const wolframAppId = wolframKeyInput ? wolframKeyInput.value.trim() : '';
      const spotifyClientId = spotifyClientIdInput ? spotifyClientIdInput.value.trim() : '';
      const spotifyClientSecret = spotifyClientSecretInput ? spotifyClientSecretInput.value.trim() : '';
      const googleClientId = googleClientIdInput ? googleClientIdInput.value.trim() : '';
      const googleClientSecret = googleClientSecretInput ? googleClientSecretInput.value.trim() : '';

      if (openrouterKey) {
        localStorage.setItem('jarvis_openrouter_api_key', openrouterKey);
        if (jarvis) {
          jarvis.openRouter.apiKey = openrouterKey;
          jarvis.hermes.apiKey = openrouterKey; // separate client instance, same key
        }
        openrouterKeyInput.value = '';
        openrouterKeyInput.placeholder = keyPlaceholder('OpenRouter API Key', openrouterKey);
      }
      if (groqKey) {
        localStorage.setItem('jarvis_groq_api_key', groqKey);
        if (jarvis) jarvis.groq.apiKey = groqKey;
        groqKeyInput.value = '';
        groqKeyInput.placeholder = keyPlaceholder('Groq API Key', groqKey);
        refreshTierControlAvailability();
      }
      if (geminiKey) {
        localStorage.setItem('jarvis_gemini_api_key', geminiKey);
        if (jarvis) jarvis.gemini.apiKey = geminiKey;
        geminiKeyInput.value = '';
        geminiKeyInput.placeholder = keyPlaceholder('Gemini API Key', geminiKey);
        refreshTierControlAvailability();
      }
      if (deepgramKey) {
        localStorage.setItem('jarvis_deepgram_api_key', deepgramKey);
        // The STT engine choice is otherwise fixed at VoiceEngine construction,
        // so a key saved mid-session would be ignored until reload. Hot-swap it
        // the same way the other keys hot-update their clients: stop whichever
        // engine currently owns the mic (clearing its old client — Deepgram
        // socket, Electron mic, or browser recognition), point the engine at
        // Deepgram, then resume wake-word listening only if it was running.
        if (voiceEngine) {
          const wasListening = Boolean(voiceEngine.isListening || voiceEngine.continuousMode);
          if (wasListening) {
            voiceEngine.stopListening();
          } else if (voiceEngine.recognition) {
            try { voiceEngine.recognition.abort(); } catch (e) {}
          }
          voiceEngine.deepgramApiKey = deepgramKey;
          voiceEngine.engine = 'deepgram';
          if (wasListening && voiceEngine.startListening() !== false) {
            if (micBtn) micBtn.classList.add('active');
          }
        }
        deepgramKeyInput.value = '';
        deepgramKeyInput.placeholder = keyPlaceholder('Deepgram API Key', deepgramKey);
      }
      if (elevenlabsKey) {
        localStorage.setItem('jarvis_elevenlabs_api_key', elevenlabsKey);
        // Hot-wired by design: speak() re-reads the key each call, so the
        // premium voice kicks in on the next reply — no restart needed.
        elevenlabsKeyInput.value = '';
        elevenlabsKeyInput.placeholder = keyPlaceholder('ElevenLabs API Key', elevenlabsKey);
      }
      if (elevenlabsVoiceId) {
        localStorage.setItem('jarvis_elevenlabs_voice_id', elevenlabsVoiceId);
        // Re-read per speak() like the key — a custom voice takes effect on
        // the next reply with no restart.
        elevenlabsVoiceIdInput.value = '';
        elevenlabsVoiceIdInput.placeholder = `ElevenLabs Voice ID: ${elevenlabsVoiceId} (saved)`;
      }
      if (wolframAppId) {
        localStorage.setItem('jarvis_wolfram_app_id', wolframAppId);
        if (jarvis) jarvis.wolfram.appId = wolframAppId;
        wolframKeyInput.value = '';
        wolframKeyInput.placeholder = keyPlaceholder('WolframAlpha AppID', wolframAppId);
      }
      if (spotifyClientId) {
        localStorage.setItem('jarvis_spotify_client_id', spotifyClientId);
        if (jarvis) jarvis.spotifyClientId = spotifyClientId;
        spotifyClientIdInput.value = '';
        spotifyClientIdInput.placeholder = keyPlaceholder('Spotify Client ID', spotifyClientId);
      }
      if (spotifyClientSecret) {
        localStorage.setItem('jarvis_spotify_client_secret', spotifyClientSecret);
        if (jarvis) jarvis.spotifyClientSecret = spotifyClientSecret;
        spotifyClientSecretInput.value = '';
        spotifyClientSecretInput.placeholder = keyPlaceholder('Spotify Client Secret', spotifyClientSecret);
      }
      if (googleClientId) {
        localStorage.setItem('jarvis_google_client_id', googleClientId);
        if (jarvis) jarvis.googleClientId = googleClientId;
        googleClientIdInput.value = '';
        googleClientIdInput.placeholder = keyPlaceholder('Google Client ID', googleClientId);
      }
      if (googleClientSecret) {
        localStorage.setItem('jarvis_google_client_secret', googleClientSecret);
        if (jarvis) jarvis.googleClientSecret = googleClientSecret;
        googleClientSecretInput.value = '';
        googleClientSecretInput.placeholder = keyPlaceholder('Google Client Secret', googleClientSecret);
      }
      if (apiKeysStatus) {
        if (openrouterKey || groqKey || geminiKey || deepgramKey || elevenlabsKey || elevenlabsVoiceId || wolframAppId || spotifyClientId || spotifyClientSecret || googleClientId || googleClientSecret) {
          apiKeysStatus.textContent = '✅ Saved.';
          apiKeysStatus.style.color = '#70a1ff';
        } else {
          apiKeysStatus.textContent = 'Enter at least one key to save.';
          apiKeysStatus.style.color = 'var(--text-dim)';
        }
      }
    });
  }
}

/**
 * Reads the currently-saved Spotify Client ID/Secret the same way
 * JarvisCore does (Settings-saved localStorage values) — kept local rather
 * than reading off the `jarvis` instance since these panels can init before
 * it's constructed.
 */
function getSavedSpotifyCredentials() {
  const clientId = localStorage.getItem('jarvis_spotify_client_id') || '';
  const clientSecret = localStorage.getItem('jarvis_spotify_client_secret') || '';
  return { clientId, clientSecret };
}

/**
 * Reads the currently-saved Google Client ID/Secret the same way
 * JarvisCore does (Settings-saved localStorage values) — kept local rather
 * than reading off the `jarvis` instance since these panels can init before
 * it's constructed.
 */
function getSavedGoogleCredentials() {
  const clientId = localStorage.getItem('jarvis_google_client_id') || '';
  const clientSecret = localStorage.getItem('jarvis_google_client_secret') || '';
  return { clientId, clientSecret };
}

/**
 * Wires the Settings modal's "Spotify Account" section to SpotifyHarness's
 * OAuth methods (which themselves wrap electron/preload.cjs -> electron/main.cjs).
 * Hidden entirely outside Electron, since the OAuth loopback server only runs
 * in the main process.
 */
function initSpotifyAccountPanel() {
  if (typeof window === 'undefined' || !window.jarvisElectron?.spotifyAuth || !jarvis) return;

  const section = document.getElementById('spotifyAccountSection');
  const statusEl = document.getElementById('spotifyAccountStatus');
  const connectBtn = document.getElementById('spotifyConnectBtn');
  const disconnectBtn = document.getElementById('spotifyDisconnectBtn');

  if (!section || !connectBtn) return;
  section.style.display = '';

  const render = (authenticated) => {
    if (statusEl) {
      statusEl.textContent = authenticated ? '✅ Connected' : 'Not connected';
      statusEl.style.color = authenticated ? '#70a1ff' : 'var(--text-dim)';
    }
    connectBtn.style.display = authenticated ? 'none' : '';
    if (disconnectBtn) disconnectBtn.style.display = authenticated ? '' : 'none';
  };

  jarvis.spotifyHarness.authStatus().then(({ authenticated }) => render(authenticated));

  connectBtn.addEventListener('click', async () => {
    const { clientId, clientSecret } = getSavedSpotifyCredentials();
    if (!clientId || !clientSecret) {
      if (statusEl) {
        statusEl.textContent = 'Save a Spotify Client ID/Secret above first.';
        statusEl.style.color = '#ff9f1c';
      }
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = 'CONNECTING… (check your browser)';
    if (statusEl) {
      statusEl.textContent = 'Approve access in the browser tab that just opened…';
      statusEl.style.color = 'var(--text-dim)';
    }

    try {
      await jarvis.spotifyHarness.login(clientId, clientSecret);
      render(true);
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Connection failed: ${err.message}`;
        statusEl.style.color = '#ff007f';
      }
      render(false);
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'CONNECT SPOTIFY ACCOUNT';
    }
  });

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      await jarvis.spotifyHarness.logout();
      render(false);
    });
  }
}

/**
 * Wires the Settings modal's "Google Account" section to
 * GoogleAccountConnector's OAuth methods (which wrap electron/preload.cjs ->
 * electron/main.cjs). Hidden entirely outside Electron, since the OAuth
 * loopback server only runs in the main process. Mirrors
 * initSpotifyAccountPanel() exactly.
 */
function initGoogleAccountPanel() {
  if (typeof window === 'undefined' || !window.jarvisElectron?.googleAuth || !jarvis) return;

  const section = document.getElementById('googleAccountSection');
  const statusEl = document.getElementById('googleAccountStatus');
  const connectBtn = document.getElementById('googleConnectBtn');
  const disconnectBtn = document.getElementById('googleDisconnectBtn');

  if (!section || !connectBtn) return;
  section.style.display = '';

  const render = (authenticated) => {
    if (statusEl) {
      statusEl.textContent = authenticated ? '✅ Connected' : 'Not connected';
      statusEl.style.color = authenticated ? '#70a1ff' : 'var(--text-dim)';
    }
    connectBtn.style.display = authenticated ? 'none' : '';
    if (disconnectBtn) disconnectBtn.style.display = authenticated ? '' : 'none';
  };

  jarvis.googleAccountConnector.authStatus().then(({ authenticated }) => render(authenticated));

  connectBtn.addEventListener('click', async () => {
    const { clientId, clientSecret } = getSavedGoogleCredentials();
    if (!clientId || !clientSecret) {
      if (statusEl) {
        statusEl.textContent = 'Save a Google Client ID/Secret above first.';
        statusEl.style.color = '#ff9f1c';
      }
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = 'CONNECTING… (check your browser)';
    if (statusEl) {
      statusEl.textContent = 'Approve access in the browser tab that just opened…';
      statusEl.style.color = 'var(--text-dim)';
    }

    try {
      await jarvis.googleAccountConnector.login(clientId, clientSecret);
      render(true);
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Connection failed: ${err.message}`;
        statusEl.style.color = '#ff007f';
      }
      render(false);
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'CONNECT GOOGLE ACCOUNT';
    }
  });

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      await jarvis.googleAccountConnector.logout();
      render(false);
    });
  }
}

/**
 * Wires the Settings modal's "Software Update" section to the main-process
 * autoUpdater via update-manager.js. Hidden entirely outside Electron
 * (plain `npm run dev` browser tab), since there's nothing to update there.
 */
function initUpdatePanel() {
  if (!isUpdateSupported()) return;

  const updateSection = document.getElementById('updateSection');
  const updateStatusText = document.getElementById('updateStatusText');
  const updateProgressTrack = document.getElementById('updateProgressTrack');
  const updateProgressFill = document.getElementById('updateProgressFill');
  const updateActionBtn = document.getElementById('updateActionBtn');
  const settingsUpdateBadge = document.getElementById('settingsUpdateBadge');

  if (!updateSection || !updateActionBtn) return;
  updateSection.style.display = '';

  let currentVersion = '';
  let latestStatus = 'checking';

  getCurrentVersion().then((version) => {
    currentVersion = version || '';
  });

  const renderState = (state) => {
    latestStatus = state.status;

    if (updateProgressTrack) updateProgressTrack.style.display = state.status === 'downloading' ? '' : 'none';
    if (updateProgressFill) updateProgressFill.style.width = `${state.progress || 0}%`;
    if (settingsUpdateBadge) settingsUpdateBadge.classList.toggle('visible', state.status === 'available' || state.status === 'ready');

    switch (state.status) {
      case 'checking':
        if (updateStatusText) updateStatusText.textContent = 'Checking for updates…';
        updateActionBtn.textContent = 'CHECKING…';
        updateActionBtn.disabled = true;
        break;
      case 'available':
        if (updateStatusText) updateStatusText.textContent = `Update available (v${state.version})`;
        updateActionBtn.textContent = 'DOWNLOAD UPDATE';
        updateActionBtn.disabled = false;
        break;
      case 'downloading':
        if (updateStatusText) updateStatusText.textContent = `Downloading update… ${state.progress || 0}%`;
        updateActionBtn.textContent = 'DOWNLOADING…';
        updateActionBtn.disabled = true;
        break;
      case 'ready':
        if (updateStatusText) updateStatusText.textContent = `Update ready (v${state.version}) — restart to install`;
        updateActionBtn.textContent = 'RESTART & INSTALL';
        updateActionBtn.disabled = false;
        break;
      case 'error':
        if (updateStatusText) updateStatusText.textContent = 'Update check failed — try again';
        updateActionBtn.textContent = 'CHECK FOR UPDATES';
        updateActionBtn.disabled = false;
        break;
      case 'idle':
      default:
        if (updateStatusText) updateStatusText.textContent = currentVersion ? `You're up to date (v${currentVersion})` : "You're up to date";
        updateActionBtn.textContent = 'CHECK FOR UPDATES';
        updateActionBtn.disabled = false;
        break;
    }
  };

  // Subscribe first, then replay the main process's last known update state
  // once — the silent launch-time check can fire (and even finish) before
  // this panel subscribed, and those events were never delivered. The replay
  // is ignored if a live event already arrived during the round-trip.
  let liveEventSeen = false;
  onUpdateState((state) => { liveEventSeen = true; renderState(state); });
  window.jarvisElectron?.update?.getState?.().then((state) => {
    if (state && !liveEventSeen) renderState(state);
  }).catch(() => {});

  updateActionBtn.addEventListener('click', () => {
    if (latestStatus === 'available') {
      downloadUpdate();
    } else if (latestStatus === 'ready') {
      installUpdate();
    } else {
      checkForUpdate();
    }
  });

  const updateLogBtn = document.getElementById('updateLogBtn');
  const updateLogBox = document.getElementById('updateLogBox');
  if (updateLogBtn && updateLogBox) {
    updateLogBtn.addEventListener('click', async () => {
      if (updateLogBox.style.display !== 'none') {
        updateLogBox.style.display = 'none';
        return;
      }
      updateLogBox.style.display = '';
      updateLogBox.textContent = 'Loading…';
      const releases = await getChangelog();

      updateLogBox.replaceChildren();
      if (!releases.length) {
        updateLogBox.textContent = 'No update log available.';
        return;
      }

      releases.forEach((r) => {
        const entry = document.createElement('div');
        entry.style.marginBottom = '4px';

        const header = document.createElement('div');
        header.textContent = `▸ ${r.version}`;
        header.style.cursor = 'pointer';
        header.style.userSelect = 'none';

        const notes = document.createElement('div');
        notes.textContent = r.notes || 'No notes for this release.';
        notes.style.whiteSpace = 'pre-wrap';
        notes.style.display = 'none';
        notes.style.padding = '4px 0 4px 16px';
        notes.style.opacity = '0.85';

        header.addEventListener('click', () => {
          const expanded = notes.style.display !== 'none';
          notes.style.display = expanded ? 'none' : '';
          header.textContent = `${expanded ? '▸' : '▾'} ${r.version}`;
        });

        entry.appendChild(header);
        entry.appendChild(notes);
        updateLogBox.appendChild(entry);
      });
    });
  }
}

/**
 * Enables/disables the tier slider and updates its label based on whether a
 * Groq or Gemini key exists (Quick/Medium/High need Groq, Ultra needs
 * Gemini — one of either is enough to unlock the slider; per-tier gating
 * happens in JarvisCore's SET_MODEL_TIER handler) — called at init and
 * again right after a key is saved in Settings, so the slider goes live
 * immediately without a page reload.
 */
function refreshTierControlAvailability() {
  const tierSlider = document.getElementById('tierSlider');
  const tierControlLabel = document.getElementById('tierControlLabel');
  if (!tierSlider || !tierControlLabel) return;

  const hasGroqKey = Boolean(localStorage.getItem('jarvis_groq_api_key'));
  const hasGeminiKey = Boolean(localStorage.getItem('jarvis_gemini_api_key'));
  tierSlider.disabled = !hasGroqKey && !hasGeminiKey;

  if (tierSlider.disabled) {
    tierControlLabel.textContent = 'Add Groq or Gemini key';
  } else {
    const tierKey = TIER_ORDER[Number(tierSlider.value)];
    tierControlLabel.textContent = MODEL_TIERS[tierKey].label;
  }
}

/**
 * Moves the slider thumb and updates its label to match a tier switch that
 * happened elsewhere (a voice/text command), so both control paths agree.
 */
function syncTierControl(tierKey) {
  const tierSlider = document.getElementById('tierSlider');
  const tierControlLabel = document.getElementById('tierControlLabel');
  if (!tierSlider || !tierControlLabel || !MODEL_TIERS[tierKey]) return;
  tierSlider.value = String(TIER_ORDER.indexOf(tierKey));
  tierControlLabel.textContent = MODEL_TIERS[tierKey].label;
}

/**
 * Wires the header's Quick/Medium/High/Ultra Groq model-tier slider. Dragging
 * it routes through the exact same processUserInput path as the voice
 * command ("switch mode to high"), so settings persistence, the no-key
 * prompt, and the spoken confirmation all stay in one place.
 */
function initTierControl() {
  const tierSlider = document.getElementById('tierSlider');
  if (!tierSlider) return;

  const settings = loadSettings();
  const tierIndex = Math.max(0, TIER_ORDER.indexOf(settings.groqModelTier));
  tierSlider.value = String(tierIndex);

  refreshTierControlAvailability();

  tierSlider.addEventListener('input', () => {
    const tierControlLabel = document.getElementById('tierControlLabel');
    const tierKey = TIER_ORDER[Number(tierSlider.value)];
    if (tierControlLabel) tierControlLabel.textContent = MODEL_TIERS[tierKey].label;
  });

  tierSlider.addEventListener('change', () => {
    const tierKey = TIER_ORDER[Number(tierSlider.value)];
    if (jarvis) jarvis.processUserInput(`switch mode to ${tierKey}`);
  });
}

/**
 * Wires the Camera Vision Harness panel's toggle button. Routes through the
 * same processUserInput text-command path as every other header/panel
 * button (see launchSteamBtn, initTierControl) so logging, agent-state
 * updates, and the spoken confirmation all stay in one place.
 */
/**
 * Pushes the live camera state into every camera toggle button (Devices
 * panel + sidebar shortcut) so their labels never lie about on/off.
 */
function syncCameraButtons() {
  if (!jarvis) return;
  const isOpen = Boolean(jarvis.cameraVisionHarness?.isOpen);
  const panelBtn = document.getElementById('cameraToggleBtn');
  if (panelBtn) panelBtn.textContent = isOpen ? 'CLOSE CAMERA 📷' : 'OPEN CAMERA 📷';
  const sideBtn = document.getElementById('sideCameraBtn');
  if (sideBtn) {
    // Update only the label span so the inline SVG icon survives the sync.
    // The label stays a single word in both states.
    const label = sideBtn.querySelector('span');
    if (label) label.textContent = 'Camera';
    else sideBtn.textContent = 'Camera';
  }
}

function initCameraVisionPanel() {
  const toggleCamera = () => {
    if (!jarvis) return;
    const isOpen = Boolean(jarvis.cameraVisionHarness?.isOpen);
    jarvis.processUserInput(isOpen ? 'close camera' : 'open camera');
  };

  const cameraToggleBtn = document.getElementById('cameraToggleBtn');
  if (cameraToggleBtn) cameraToggleBtn.addEventListener('click', toggleCamera);
  const sideCameraBtn = document.getElementById('sideCameraBtn');
  if (sideCameraBtn) sideCameraBtn.addEventListener('click', toggleCamera);
}

/**
 * Wires the Location panel: on load, asks LocationHarness for the user's
 * position once (not watchPosition — one-shot only, per the spec's scope
 * decision). On success it embeds a Google Maps iframe (keyless embed —
 * free, detailed, higher quality than the old Leaflet/OSM tiles) centered
 * on those coords; on failure it leaves the map container empty and shows
 * the harness's graceful message, the same degradation pattern as the
 * Steam/Spotify "not connected" states.
 */
function initLocationPanel() {
  const mapEl = document.getElementById('locationMap');
  const statusEl = document.getElementById('locationStatus');
  if (!mapEl || !statusEl) return;

  const locationHarness = new LocationHarness();
  locationHarness.getCurrentPosition().then((result) => {
    if (!result.success) {
      statusEl.textContent = result.message;
      statusEl.style.color = 'var(--text-dim)';
      return;
    }

    const lat = result.lat.toFixed(5);
    const lon = result.lon.toFixed(5);
    const frame = document.createElement('iframe');
    frame.className = 'google-map-frame';
    frame.loading = 'lazy';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'no-referrer-when-downgrade';
    frame.src = `https://www.google.com/maps?q=${lat},${lon}&z=13&output=embed`;
    mapEl.replaceChildren(frame);

    statusEl.textContent = `Position locked at ${lat}, ${lon}.`;
    statusEl.style.color = 'var(--cyan-bright)';
  });
}

/**
 * Mirrors console log entries into the right-rail Recent Activity feed.
 * Safe to call before initDashboard runs — no-ops when the rail is absent.
 */
function pushActivity(type, message) {
  const list = document.getElementById('activityList');
  if (!list || !message) return;
  const item = document.createElement('div');
  item.className = 'activity-item';
  const icon = type === 'USER' ? '💬' : (type === 'ARIA' ? '🔷' : (type === 'SUCCESS' ? '✅' : (type === 'WARNING' ? '⚠️' : '⚙️')));
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const text = document.createElement('div');
  text.innerHTML = `<div class="a-text"></div><div class="a-time">${time}</div>`;
  text.querySelector('.a-text').textContent = String(message).slice(0, 140);
  const iconEl = document.createElement('div');
  iconEl.className = 'a-icon';
  iconEl.textContent = icon;
  item.appendChild(iconEl);
  item.appendChild(text);
  list.prepend(item);
  while (list.children.length > 6) list.removeChild(list.lastChild);
}

/**
 * Switches the visible dashboard view. 'settings' opens the Settings modal
 * instead of switching views.
 */
function switchView(name) {
  if (name === 'settings') {
    const btn = document.getElementById('settingsBtn');
    if (btn) btn.click();
    return;
  }
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-view') === name);
  });
  document.querySelectorAll('.view').forEach(el => {
    el.classList.toggle('active', el.id === `view-${name}`);
  });
  if (name === 'calendar') refreshCalendar();
  if (name === 'memory') refreshNotes();
  if (name === 'devices' || name === 'skills') refreshDevices();
}

/**
 * Reads this morning/afternoon/evening greeting + today's date into the
 * Home view and the right-rail Today header.
 */
/**
 * Display name from Settings (defaults to Avanish). Blank falls back to a
 * bare greeting so a fresh profile never renders "Good evening, .".
 */
function currentUserName() {
  try {
    return String(loadSettings().userName || '').trim();
  } catch (e) {
    return 'Avanish';
  }
}

/**
 * Applies the Settings identity everywhere it surfaces: hero greeting,
 * avatar initial, and account-menu name. Called on boot and right after
 * the name is edited so it takes effect with no reload.
 */
function applyUserIdentity() {
  const name = currentUserName();
  renderGreeting();
  const initial = ((name.match(/[A-Za-z0-9]/) || ['A'])[0]).toUpperCase();
  const avatarBtn = document.getElementById('avatarBtn');
  if (avatarBtn) avatarBtn.textContent = initial;
  document.querySelectorAll('#avatarMenu .avatar-sm').forEach((el) => { el.textContent = initial; });
  const nameEl = document.querySelector('#avatarMenu .avatar-name');
  if (nameEl) nameEl.textContent = name || 'Local User';
}

function renderGreeting() {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'Good night' : (hour < 12 ? 'Good morning' : (hour < 18 ? 'Good afternoon' : 'Good evening'));
  const userName = currentUserName();
  const title = document.getElementById('greetingTitle');
  if (title) title.textContent = userName ? `${part}, ${userName}.` : `${part}.`;
  const dateEl = document.getElementById('todayDate');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
}

const GREETING_SUB_DEFAULT = "I'm here, and I've got a few things for you.";

/**
 * Swaps the hero greeting for ARIA's latest spoken output.
 */
function showAriaResponse(text) {
  if (!text) return;
  const title = document.getElementById('greetingTitle');
  const sub = document.getElementById('greetingSub');
  if (title) {
    title.textContent = text;
    const wrap = title.closest('.sphere-greeting');
    if (wrap) wrap.classList.add('responding');
  }
  if (sub) sub.textContent = '— ARIA';
}

/**
 * Reverts the hero to the standby time-of-day greeting once ARIA is idle.
 */
function restoreGreeting() {
  renderGreeting();
  const sub = document.getElementById('greetingSub');
  if (sub) sub.textContent = GREETING_SUB_DEFAULT;
  const wrap = document.querySelector('.sphere-greeting');
  if (wrap) wrap.classList.remove('responding');
}

/**
 * Sidebar quote widget: shows a famous quote, rotating to the next one
 * every minute with a rise-and-defocus animation. Sequential rotation so a
 * quote never repeats until the full list has cycled.
 */
let quoteIndex = 0;

function renderQuote() {
  const card = document.getElementById('quoteCard');
  const textEl = document.getElementById('quoteText');
  const authorEl = document.getElementById('quoteAuthor');
  if (!card || !textEl || !authorEl || !QUOTES.length) return;
  const quote = QUOTES[quoteIndex % QUOTES.length];
  textEl.textContent = quote.text;
  authorEl.textContent = `— ${quote.author}`;
  // Re-trigger the entrance animation on every rotation.
  card.classList.remove('quote-in');
  void card.offsetWidth;
  card.classList.add('quote-in');
}

function initQuoteRotator() {
  if (!QUOTES.length) return;
  renderQuote();
  setInterval(() => {
    quoteIndex = nextQuoteIndex(quoteIndex);
    renderQuote();
  }, 60000);
}

function formatEventStart(start) {
  if (!start) return '';
  try {
    const d = new Date(typeof start === 'string' ? start : (start.dateTime || start.date));
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

function calendarConfigured() {
  return Boolean(jarvis && jarvis.googleClientId && jarvis.googleClientSecret);
}

/**
 * Read-only calendar fetch for the Home Upcoming card, Today rail card,
 * and Calendar view. Never speaks — failures degrade to connect hints.
 */
async function refreshCalendar() {
  const upcoming = document.getElementById('upcomingList');
  const today = document.getElementById('todayList');
  const calList = document.getElementById('calList');
  const hint = document.getElementById('calConnectHint');

  if (!calendarConfigured()) {
    if (upcoming) upcoming.textContent = 'Connect Google Calendar in Settings to see events.';
    if (today) today.innerHTML = '<div class="empty-note">Connect Google Calendar in Settings.</div>';
    if (calList) calList.innerHTML = '';
    if (hint) hint.style.display = 'flex';
    return;
  }
  if (hint) hint.style.display = 'none';

  let events = [];
  try {
    const result = await jarvis.calendarHarness.listUpcoming(jarvis.googleClientId, jarvis.googleClientSecret, 8);
    if (result && result.success) events = result.events || [];
  } catch (e) {
    events = [];
  }

  if (upcoming) {
    upcoming.innerHTML = events.length
      ? events.slice(0, 2).map(ev => `<div><span class="ev-time">${formatEventStart(ev.start)}</span><br>${escapeHtml(ev.title || '(untitled)')}</div>`).join('')
      : 'No upcoming events — enjoy the quiet.';
  }
  if (today) {
    today.innerHTML = events.length
      ? events.slice(0, 4).map(ev => `<div class="today-ev"><time>${formatEventStart(ev.start)}</time><span>${escapeHtml(ev.title || '(untitled)')}</span></div>`).join('')
      : '<div class="empty-note">No events yet today.</div>';
  }
  if (calList) {
    calList.innerHTML = events.length
      ? events.map(ev => `<div class="cal-row"><time>${formatEventStart(ev.start)}</time><span>${escapeHtml(ev.title || '(untitled)')}</span></div>`).join('')
      : '<div class="empty-note">Nothing on the calendar.</div>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let filesHarness = null;

/**
 * Read-only notes fetch for the Memory view, via a renderer-side
 * FileSystemHarness (Electron IPC; graceful "not available" outside it).
 */
async function refreshNotes() {
  const list = document.getElementById('notesList');
  if (!list) return;
  if (!filesHarness && typeof FileSystemHarness !== 'undefined') {
    try {
      filesHarness = new FileSystemHarness({ onLog: () => {} });
    } catch (e) {
      filesHarness = null;
    }
  }
  let result = null;
  try {
    result = filesHarness ? await filesHarness.listNotes() : null;
  } catch (e) {
    result = null;
  }
  if (!result || !result.success) {
    list.innerHTML = `<div class="empty-hint">${escapeHtml((result && result.message) || 'Notes live in the ARIA desktop app — open this view in Electron to browse them.')}</div>`;
    return;
  }
  if (!result.files.length) {
    list.innerHTML = '<div class="empty-note">No notes saved yet — say "remember ..." and I\'ll keep it here.</div>';
    return;
  }
  list.innerHTML = '';
  result.files.forEach(f => {
    const row = document.createElement('div');
    row.className = 'note-row';
    const label = document.createElement('span');
    label.innerHTML = `<b></b> <span class="n-preview"></span>`;
    label.querySelector('b').textContent = f.filename;
    label.querySelector('.n-preview').textContent = f.preview ? `— ${f.preview}` : '';
    const open = document.createElement('button');
    open.className = 'btn-toggle';
    open.textContent = 'READ';
    open.addEventListener('click', async () => {
      try {
        const full = await filesHarness.readNote(f.filename);
        if (full && full.success) {
          label.querySelector('.n-preview').textContent = `— ${full.content.slice(0, 200)}`;
        }
      } catch (e) { /* keep the preview */ }
    });
    row.appendChild(label);
    row.appendChild(open);
    list.appendChild(row);
  });
}

/**
 * Rebuilds the right-rail connections rows from live status text the
 * harness panels already maintain. Core system health (provider, internet,
 * voice) lives in the static System Status rows above — voice shown twice
 * on the same rail was redundant.
 */
function refreshDevices() {
  const list = document.getElementById('devicesList');
  if (!list) return;
  const textOf = (id, fallback) => {
    const el = document.getElementById(id);
    return el && el.textContent ? el.textContent.trim() : fallback;
  };
  const rows = [
    { icon: '📧', name: 'Google', state: textOf('googleAccountStatus', 'Not connected') },
    { icon: '🎵', name: 'Spotify', state: textOf('spotifyAccountStatus', 'Not connected') },
    { icon: '🎮', name: 'Steam', state: textOf('steamLibraryStatus', 'Not connected') }
  ];
  list.innerHTML = '';
  rows.forEach(r => {
    const off = /not connected|inactive|unavailable|standby|idle/i.test(r.state);
    const row = document.createElement('div');
    row.className = 'device-row';
    row.innerHTML = `<div class="d-icon">${r.icon}</div><div><div></div><small class="${off ? 'off' : ''}"></small></div>`;
    row.children[1].children[0].textContent = r.name;
    row.children[1].children[1].textContent = off ? 'Not linked' : r.state.length > 42 ? 'Linked' : r.state;
    list.appendChild(row);
  });

  const provider = document.getElementById('sysProvider');
  if (provider && jarvis && jarvis._activeProviderLabel) {
    try { provider.textContent = `${jarvis._activeProviderLabel()} · Running`; } catch (e) { /* keep placeholder */ }
  }
  const net = document.getElementById('sysNet');
  if (net) net.textContent = (typeof navigator !== 'undefined' && !navigator.onLine) ? 'Offline' : 'Connected';
  // The Voice row is owned by paintVoiceState (updateStatus) — polling here
  // would clobber Thinking/Speaking back to a two-state label.
}

/**
 * Renders the capability grid on the Skills view. State is derived from
 * what's actually configured — keys present, Electron IPC available.
 */
function renderSkills() {
  const grid = document.getElementById('skillsGrid');
  if (!grid) return;
  const has = (key) => { try { return Boolean(localStorage.getItem(key)); } catch (e) { return false; } };
  const isElectron = typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron;
  const skills = [
    { icon: '🎙️', name: 'Voice I/O', desc: 'Wake-word listening and spoken responses.', on: true },
    { icon: '🔍', name: 'Web Search', desc: 'Live Google results with auto-opened tabs.', on: true },
    { icon: '🎮', name: 'Steam', desc: 'Open the client or launch owned games by voice.', on: has('jarvis_steam_api_key') },
    { icon: '🎵', name: 'Spotify', desc: 'Open, search, and play tracks or your library.', on: has('jarvis_spotify_client_id') },
    { icon: '📧', name: 'Gmail', desc: 'Read-only inbox check, search, and read-aloud.', on: has('jarvis_google_client_id') },
    { icon: '📅', name: 'Calendar', desc: 'List, search, and create Google Calendar events.', on: has('jarvis_google_client_id') },
    { icon: '📷', name: 'Camera Vision', desc: 'Webcam feed with live object detection.', on: isElectron },
    { icon: '🖥️', name: 'Screen Vision', desc: 'Screenshot Q&A through the vision model.', on: isElectron },
    { icon: '🗺️', name: 'Maps & Places', desc: 'Nearby search and driving directions.', on: isElectron },
    { icon: '🌦️', name: 'Weather', desc: 'Real conditions at your current position.', on: isElectron },
    { icon: '🔢', name: 'Math', desc: 'WolframAlpha-backed computation.', on: has('jarvis_wolfram_app_id') },
    { icon: '📝', name: 'Memory Notes', desc: 'Private on-device notes ARIA can recall.', on: isElectron }
  ];
  grid.innerHTML = '';
  skills.forEach(s => {
    const card = document.createElement('div');
    card.className = 'skill-card';
    card.innerHTML = `<div class="s-icon">${s.icon}</div><b></b><small></small><div class="s-state"></div>`;
    card.querySelector('b').textContent = s.name;
    card.querySelector('small').textContent = s.desc;
    const state = card.querySelector('.s-state');
    state.textContent = s.on ? '● READY' : '○ SETUP NEEDED';
    if (!s.on) state.classList.add('off');
    grid.appendChild(card);
  });
}

/**
 * Tasks view rendering over tasks-store.js (localStorage, per-device).
 */
function renderTasks() {
  const list = document.getElementById('tasksList');
  if (!list) return;
  let tasks = [];
  try { tasks = loadTasks(); } catch (e) { tasks = []; }
  list.innerHTML = '';
  if (!tasks.length) {
    list.innerHTML = '<div class="empty-note">Nothing here yet — add your first task above, Sir.</div>';
    return;
  }
  tasks.forEach(t => {
    const row = document.createElement('div');
    row.className = `task-row${t.done ? ' done' : ''}`;
    const check = document.createElement('button');
    check.className = 'task-check';
    check.textContent = '✓';
    check.title = 'Toggle done';
    check.addEventListener('click', () => { try { toggleTask(t.id); } catch (e) {} renderTasks(); });
    const label = document.createElement('span');
    label.textContent = t.text;
    const del = document.createElement('button');
    del.className = 'task-del';
    del.textContent = '✕';
    del.title = 'Delete task';
    del.addEventListener('click', () => { try { removeTask(t.id); } catch (e) {} renderTasks(); });
    row.appendChild(check);
    row.appendChild(label);
    row.appendChild(del);
    list.appendChild(row);
  });
  try {
    if (tasks.some(t => t.done)) {
      const clear = document.createElement('button');
      clear.className = 'btn-toggle tasks-clear';
      clear.textContent = 'CLEAR COMPLETED';
      clear.addEventListener('click', () => { try { clearCompleted(); } catch (e) {} renderTasks(); });
      list.appendChild(clear);
    }
  } catch (e) { /* read-only render */ }
}

/**
 * Dashboard shell wiring: nav, top search, greeting, rail, tasks,
 * calendar/memory refresh, and periodic device-status refresh.
 */
function initDashboard(onLog) {
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.getAttribute('data-view')));
  });
  document.querySelectorAll('[data-goto]').forEach(el => {
    el.addEventListener('click', () => switchView(el.getAttribute('data-goto')));
  });

  const focusCommand = () => { if (textInput) textInput.focus(); };
  const topSearch = document.getElementById('topSearch');
  if (topSearch) {
    topSearch.addEventListener('click', focusCommand);
    topSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') focusCommand(); });
  }
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      focusCommand();
    }
  });

  if (stopBtn) stopBtn.addEventListener('click', () => { onStopBtn(); focusCommand(); });

  // Press ripple on every interactive button (CSS animates .ripple; the host
  // classes get position/clipping from the shared ripple-host rule).
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn-toggle,.btn-harness,button.side-shortcut,.nav-item,.icon-btn,.game-launch-btn,.btn-steam-save,.btn-steam-clear,.task-check,.task-del');
    if (!btn || btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const size = Math.max(rect.width, rect.height) * 2.2;
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    ripple.addEventListener('animationend', () => ripple.remove());
    btn.appendChild(ripple);
  });
  // Account menu (top-right avatar): toggle on click, close on
  // outside-click / Escape. Restart simply reloads the renderer.
  const avatarBtn = document.getElementById('avatarBtn');
  const avatarMenu = document.getElementById('avatarMenu');
  if (avatarBtn && avatarMenu) {
    avatarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      avatarMenu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!avatarMenu.classList.contains('open')) return;
      if (!e.target.closest('#avatarMenu') && !e.target.closest('#avatarBtn')) {
        avatarMenu.classList.remove('open');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') avatarMenu.classList.remove('open');
    });
    const avatarSettings = document.getElementById('avatarSettingsBtn');
    if (avatarSettings) avatarSettings.addEventListener('click', () => {
      avatarMenu.classList.remove('open');
      const settings = document.getElementById('settingsBtn');
      if (settings) settings.click();
    });
    const avatarRestart = document.getElementById('avatarRestartBtn');
    if (avatarRestart) avatarRestart.addEventListener('click', () => {
      window.location.reload();
    });
    const avatarVersion = document.getElementById('avatarVersion');
    if (avatarVersion) {
      try {
        const maybeVersion = getCurrentVersion();
        if (maybeVersion && typeof maybeVersion.then === 'function') {
          maybeVersion.then((v) => { if (v) avatarVersion.textContent = `ARIA v${v}`; }).catch(() => {});
        } else if (maybeVersion) {
          avatarVersion.textContent = `ARIA v${maybeVersion}`;
        }
      } catch (e) { /* version stays generic outside Electron */ }
    }
  }

  // Quote rotator: famous quotes, one per minute, animated swap.
  initQuoteRotator();

  applyUserIdentity();
  renderSkills();
  renderTasks();
  refreshDevices();

  const taskInput = document.getElementById('taskInput');
  const taskAdd = document.getElementById('taskAddBtn');
  const submitTask = () => {
    if (!taskInput) return;
    try { addTask(taskInput.value); } catch (e) {}
    taskInput.value = '';
    renderTasks();
  };
  if (taskAdd) taskAdd.addEventListener('click', submitTask);
  if (taskInput) taskInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitTask(); });

  const calRefresh = document.getElementById('calRefreshBtn');
  if (calRefresh) calRefresh.addEventListener('click', refreshCalendar);
  const notesRefresh = document.getElementById('notesRefreshBtn');
  if (notesRefresh) notesRefresh.addEventListener('click', refreshNotes);

  refreshCalendar();
  setInterval(() => { refreshDevices(); }, 30000);

  if (onLog) onLog({ type: 'SUCCESS', message: '[DASHBOARD] ARIA home interface ready.' });
}

// Launch application on DOM load
window.addEventListener('DOMContentLoaded', initApp);
