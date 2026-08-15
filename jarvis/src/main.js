import { VoiceEngine } from './voice-engine.js';
import { BrowserHarness } from './harness.js';
import { JarvisCore } from './jarvis-core.js';
import { ConversationController } from './conversation-controller.js';
import { loadSettings, saveSettings } from './settings.js';
import { isUpdateSupported, getCurrentVersion, checkForUpdate, downloadUpdate, installUpdate, onUpdateState, getChangelog } from './update-manager.js';
import { MODEL_TIERS, TIER_ORDER } from './model-tiers.js';

// DOM Element References
const micBtn = document.getElementById('micBtn');
const transcriptDisplay = document.getElementById('transcriptDisplay');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const terminalBox = document.getElementById('terminalBox');
const swarmList = document.getElementById('swarmList');
const steamGamesGrid = document.getElementById('steamGamesGrid');
const launchSteamBtn = document.getElementById('launchSteamBtn');
const muteBtn = document.getElementById('muteBtn');
const viewportPlaceholder = document.getElementById('viewportPlaceholder');
const viewportFrame = document.getElementById('viewportFrame');
const viewportTitle = document.getElementById('viewportTitle');
const viewportExternalLink = document.getElementById('viewportExternalLink');
const tabsOpenedCount = document.getElementById('tabsOpenedCount');
const visualizerCanvas = document.getElementById('visualizerCanvas');
const speechMeter = document.getElementById('speechMeter');
const speechMeterBars = speechMeter ? Array.from(speechMeter.querySelectorAll('.speech-meter-bar')) : [];

// Visualizer Canvas Context
const ctx = visualizerCanvas ? visualizerCanvas.getContext('2d') : null;
let animationFrameId = null;
let meterLevel = 0; // 0..1 current displayed level, decays over time
let meterDecayFrameId = null;

// Initialize System Components
let voiceEngine;
let harness;
let jarvis;
let isMuted = false;

// Wake-word / conversation-mode state machine ("Jarvis" / "Hey Jarvis")
const conversationController = new ConversationController();
let wakeTimeoutId = null;
let conversationTimeoutId = null;

function initApp() {
  // 1. Terminal logger helper
  const addLog = ({ type = 'JARVIS', message }) => {
    if (!terminalBox) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${message}`;
    terminalBox.appendChild(entry);
    terminalBox.scrollTop = terminalBox.scrollHeight;
  };

  // 2. Status updater helper
  const updateStatus = ({ status, message }) => {
    if (statusText) statusText.textContent = status;
    if (statusDot) {
      statusDot.className = 'status-dot';
      if (status === 'SPEAKING') statusDot.classList.add('speaking');
      if (status === 'LISTENING') statusDot.classList.add('listening');
    }

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
        // Not addressed to JARVIS — ignore ambient speech while passively listening.
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
          if (transcriptDisplay) transcriptDisplay.textContent = 'Say "Jarvis" to give a command...';
        }, conversationController.wakeTimeoutMs);
        return;
      }

      if (result.action === 'DISPATCH_COMMAND') {
        clearTimeout(wakeTimeoutId);
        if (result.chime) {
          // "Hey Jarvis, play Dota" — wake word + command in one breath. This is
          // the only case that needs a fresh chime here: the AWAIT_COMMAND branch
          // above already played it when "Jarvis" was said alone, and in-conversation
          // follow-ups intentionally stay silent (see spec: no chime per turn).
          voiceEngine.playBeep(1000, 0.08, 'sine');
        }
        clearTimeout(conversationTimeoutId);
        conversationTimeoutId = setTimeout(() => {
          conversationController.onConversationTimeout();
          voiceEngine.playBeep(500, 0.12, 'sine');
          if (transcriptDisplay) transcriptDisplay.textContent = 'Conversation ended. Say "Jarvis" to start.';
        }, conversationController.conversationTimeoutMs);
        jarvis.processUserInput(result.command, result.alternatives);
        return;
      }

      if (result.action === 'END_CONVERSATION') {
        clearTimeout(conversationTimeoutId);
        voiceEngine.playBeep(500, 0.12, 'sine');
        if (transcriptDisplay) transcriptDisplay.textContent = 'Conversation ended. Say "Jarvis" to start.';
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
    },
    onSpeechMeter: ({ active, intensity }) => {
      if (active) pulseMeter(intensity);
    }
  });

  jarvis = new JarvisCore(voiceEngine, harness, {
    onLog: addLog,
    onStatusChange: updateStatus,
    onResponse: ({ text, actionType, data }) => {
      addLog({ type: 'JARVIS', message: text });
      if (actionType === 'SET_MODEL_TIER' && data?.applied) {
        syncTierControl(data.tier);
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

  // 8. Steam Library Credential Setup Panel
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
          steamLibraryStatus.style.color = '#39ff14';
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

  // 8d. Model-Tier Slider (Quick/Medium/High/Ultra Groq models)
  initTierControl();

  // Voice & Mute Control Handlers
  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (voiceEngine.isListening) {
        voiceEngine.stopListening();
        micBtn.classList.remove('active');
        conversationController.reset();
        clearTimeout(wakeTimeoutId);
        clearTimeout(conversationTimeoutId);
        if (transcriptDisplay) transcriptDisplay.textContent = 'Voice input paused.';
      } else {
        const success = voiceEngine.startListening();
        if (success !== false) {
          micBtn.classList.add('active');
          if (transcriptDisplay) transcriptDisplay.textContent = 'Say "Jarvis" to give a command...';
        }
      }
    });
  }

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
    if (val) {
      textInput.value = '';
      jarvis.processUserInput(val);
    }
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
      }
    });
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
    if (transcriptDisplay) transcriptDisplay.textContent = 'Say "Jarvis" to give a command...';
    addLog({ type: 'HARNESS', message: '[WAKE WORD] Passive listening active. Say "Jarvis" or "Hey Jarvis" to issue a command.' });
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
    const coreRadius = isSpeaking ? 42 + Math.sin(phase * 4) * 8 : (isListening ? 38 + Math.sin(phase * 2) * 5 : 34);
    const grad = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, coreRadius * 1.8);

    if (isSpeaking) {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, '#ffaa00');
      grad.addColorStop(1, 'rgba(255, 51, 102, 0.0)');
    } else if (isListening) {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, '#00f3ff');
      grad.addColorStop(1, 'rgba(0, 119, 255, 0.0)');
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
      const amp = isSpeaking ? 16 * Math.sin(phase * 3 + i * 0.4) : (isListening ? 10 * Math.cos(phase * 2 + i * 0.3) : 3 * Math.sin(phase + i * 0.2));
      const r = baseRadius + amp;
      const x = centerX + Math.cos(angle) * r;
      const y = centerY + Math.sin(angle) * r;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    ctx.strokeStyle = isSpeaking ? '#ffaa00' : (isListening ? '#00f3ff' : 'rgba(0, 243, 255, 0.5)');
    ctx.lineWidth = 3;
    ctx.shadowBlur = 15;
    ctx.shadowColor = isSpeaking ? '#ffaa00' : '#00f3ff';
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
  const openTabToggle = document.getElementById('openTabToggle');
  const voiceGenderMale = document.getElementById('voiceGenderMale');
  const voiceGenderFemale = document.getElementById('voiceGenderFemale');
  const soundMeterToggle = document.getElementById('soundMeterToggle');
  const useGroqToggle = document.getElementById('useGroqToggle');
  const openrouterKeyInput = document.getElementById('openrouterKeyInput');
  const groqKeyInput = document.getElementById('groqKeyInput');
  const deepgramKeyInput = document.getElementById('deepgramKeyInput');
  const wolframKeyInput = document.getElementById('wolframKeyInput');
  const spotifyClientIdInput = document.getElementById('spotifyClientIdInput');
  const spotifyClientSecretInput = document.getElementById('spotifyClientSecretInput');
  const apiKeysSaveBtn = document.getElementById('apiKeysSaveBtn');
  const apiKeysStatus = document.getElementById('apiKeysStatus');

  if (!settingsBtn || !settingsModal) return;

  const settings = loadSettings();
  if (openTabToggle) openTabToggle.checked = settings.openTabOnSearch;
  if (voiceGenderMale) voiceGenderMale.checked = settings.voiceGender === 'male';
  if (voiceGenderFemale) voiceGenderFemale.checked = settings.voiceGender === 'female';
  if (soundMeterToggle) soundMeterToggle.checked = settings.soundMeterEnabled;
  if (useGroqToggle) useGroqToggle.checked = settings.useGroq;
  applySoundMeterVisibility(settings.soundMeterEnabled);

  if (openrouterKeyInput && localStorage.getItem('jarvis_openrouter_api_key')) {
    openrouterKeyInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (groqKeyInput && localStorage.getItem('jarvis_groq_api_key')) {
    groqKeyInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (deepgramKeyInput && localStorage.getItem('jarvis_deepgram_api_key')) {
    deepgramKeyInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (wolframKeyInput && localStorage.getItem('jarvis_wolfram_app_id')) {
    wolframKeyInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (spotifyClientIdInput && localStorage.getItem('jarvis_spotify_client_id')) {
    spotifyClientIdInput.placeholder = '••••••••••••••••• (saved)';
  }
  if (spotifyClientSecretInput && localStorage.getItem('jarvis_spotify_client_secret')) {
    spotifyClientSecretInput.placeholder = '••••••••••••••••• (saved)';
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

  if (apiKeysSaveBtn) {
    apiKeysSaveBtn.addEventListener('click', () => {
      const openrouterKey = openrouterKeyInput ? openrouterKeyInput.value.trim() : '';
      const groqKey = groqKeyInput ? groqKeyInput.value.trim() : '';
      const deepgramKey = deepgramKeyInput ? deepgramKeyInput.value.trim() : '';
      const wolframAppId = wolframKeyInput ? wolframKeyInput.value.trim() : '';
      const spotifyClientId = spotifyClientIdInput ? spotifyClientIdInput.value.trim() : '';
      const spotifyClientSecret = spotifyClientSecretInput ? spotifyClientSecretInput.value.trim() : '';

      if (openrouterKey) {
        localStorage.setItem('jarvis_openrouter_api_key', openrouterKey);
        if (jarvis) jarvis.openRouter.apiKey = openrouterKey;
        openrouterKeyInput.value = '';
        openrouterKeyInput.placeholder = '••••••••••••••••• (saved)';
      }
      if (groqKey) {
        localStorage.setItem('jarvis_groq_api_key', groqKey);
        if (jarvis) jarvis.groq.apiKey = groqKey;
        groqKeyInput.value = '';
        groqKeyInput.placeholder = '••••••••••••••••• (saved)';
        refreshTierControlAvailability();
      }
      if (deepgramKey) {
        localStorage.setItem('jarvis_deepgram_api_key', deepgramKey);
        if (voiceEngine) voiceEngine.deepgramApiKey = deepgramKey;
        deepgramKeyInput.value = '';
        deepgramKeyInput.placeholder = '••••••••••••••••• (saved)';
      }
      if (wolframAppId) {
        localStorage.setItem('jarvis_wolfram_app_id', wolframAppId);
        if (jarvis) jarvis.wolfram.appId = wolframAppId;
        wolframKeyInput.value = '';
        wolframKeyInput.placeholder = '••••••••••••••••• (saved)';
      }
      if (spotifyClientId) {
        localStorage.setItem('jarvis_spotify_client_id', spotifyClientId);
        if (jarvis) jarvis.spotifyClientId = spotifyClientId;
        spotifyClientIdInput.value = '';
        spotifyClientIdInput.placeholder = '••••••••••••••••• (saved)';
      }
      if (spotifyClientSecret) {
        localStorage.setItem('jarvis_spotify_client_secret', spotifyClientSecret);
        if (jarvis) jarvis.spotifyClientSecret = spotifyClientSecret;
        spotifyClientSecretInput.value = '';
        spotifyClientSecretInput.placeholder = '••••••••••••••••• (saved)';
      }

      if (apiKeysStatus) {
        if (openrouterKey || groqKey || deepgramKey || wolframAppId || spotifyClientId || spotifyClientSecret) {
          apiKeysStatus.textContent = '✅ Saved.';
          apiKeysStatus.style.color = '#39ff14';
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
      statusEl.style.color = authenticated ? '#39ff14' : 'var(--text-dim)';
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
        statusEl.style.color = '#ff3b3b';
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

  onUpdateState(renderState);

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
 * Groq key exists — called at init and again right after a Groq key is saved
 * in Settings, so the slider goes live immediately without a page reload.
 */
function refreshTierControlAvailability() {
  const tierSlider = document.getElementById('tierSlider');
  const tierControlLabel = document.getElementById('tierControlLabel');
  if (!tierSlider || !tierControlLabel) return;

  const hasGroqKey = Boolean(localStorage.getItem('jarvis_groq_api_key'));
  tierSlider.disabled = !hasGroqKey;

  if (!hasGroqKey) {
    tierControlLabel.textContent = 'Add Groq key';
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

// Launch application on DOM load
window.addEventListener('DOMContentLoaded', initApp);
