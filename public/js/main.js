import { el, state } from './state.js';
import { log } from './log.js';
import { loadVoices, updateSelectedVoice, setWaveform, speak } from './audio.js';
import { toggleCamera, loadObjectDetectionModel } from './camera.js';
import { closeVisualPanel } from './visual-panel.js';
import { resetWidgets, startWidgetTicker } from './widgets.js';
import { initSpeechEngine, triggerManualListen } from './speech.js';
import { processUserCommand } from './gemini.js';

function saveKey() {
    localStorage.setItem('gemini_key', el.apiKeyInput.value.trim());
}

function requestLocation() {
    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
            (pos) => { state.userLocationString = `Lat: ${pos.coords.latitude.toFixed(4)}, Lon: ${pos.coords.longitude.toFixed(4)}`; },
            () => { state.userLocationString = "Location unavailable."; },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    }
}

function toggleChatDrawer() {
    el.chatDrawer.classList.toggle('open');
}

async function toggleSystem() {
    if (!state.isSystemActive) {
        const key = el.apiKeyInput.value.trim();
        if (!key) { alert("Please enter a valid Gemini API Key."); return; }
        saveKey();
        requestLocation();
        state.isSystemActive = true;
        el.powerBtn.innerText = "SHUTDOWN";
        el.statusDisplay.innerText = "ONLINE: LISTENING FOR VOICE...";
        el.core.className = "ring core";
        if (!state.recognition) initSpeechEngine();
        try { state.recognition.start(); } catch (e) {}
        speak("Welcome back, sir.");
        log("J.A.R.V.I.S.", "System online.", "jarvis-log");
    } else {
        state.isSystemActive = false;
        el.powerBtn.innerText = "INITIALIZE";
        el.statusDisplay.innerText = "SYSTEM OFFLINE";
        el.core.className = "ring core";
        if (state.recognition) state.recognition.stop();
        window.speechSynthesis.cancel();
        setWaveform(false);
        state.chatHistory = [];
        resetWidgets();
        await toggleCamera(false);
        closeVisualPanel();
        el.reactorWrapper.classList.remove('shifted-up');
        log("J.A.R.V.I.S.", "System offline.", "jarvis-log");
    }
}

function handleManualCommand() {
    const cmd = el.manualCmdInput.value.trim();
    if (cmd) {
        el.manualCmdInput.value = '';
        processUserCommand(cmd);
    }
}

function wireEvents() {
    el.voiceSelect.addEventListener('change', updateSelectedVoice);
    el.apiKeyInput.addEventListener('change', saveKey);
    el.camToggleBtn.addEventListener('click', () => toggleCamera());
    el.camCloseBtn.addEventListener('click', () => toggleCamera(false));
    el.drawerToggleBtn.addEventListener('click', toggleChatDrawer);
    el.drawerCloseBtn.addEventListener('click', toggleChatDrawer);
    el.powerBtn.addEventListener('click', toggleSystem);
    el.reactorTarget.addEventListener('click', () => {
        if (!state.isSystemActive) toggleSystem();
        else triggerManualListen();
    });
    el.visualCloseBtn.addEventListener('click', closeVisualPanel);
    el.sendCmdBtn.addEventListener('click', handleManualCommand);
    el.manualCmdInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleManualCommand();
    });
}

function init() {
    mermaid.initialize({ startOnLoad: false, theme: 'dark' });

    if (localStorage.getItem('gemini_key')) {
        el.apiKeyInput.value = localStorage.getItem('gemini_key');
    }

    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();

    loadObjectDetectionModel();
    startWidgetTicker();
    wireEvents();
}

init();
