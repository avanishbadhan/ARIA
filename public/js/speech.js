import { el, state } from './state.js';
import { processUserCommand } from './gemini.js';

export function initSpeechEngine() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    state.recognition = new SpeechRecognition();
    state.recognition.continuous = false;
    state.recognition.interimResults = false;
    state.recognition.lang = 'en-US';

    state.recognition.onresult = (event) => {
        if (state.isProcessing) return;
        const transcript = event.results[0][0].transcript.toLowerCase().trim();
        if (transcript.includes("hey jarvis") || transcript.includes("jarvis")) {
            const cmd = transcript.split(/hey jarvis|jarvis/i).pop().trim();
            if (cmd.length > 2) {
                processUserCommand(cmd);
            } else {
                el.statusDisplay.innerText = "STANDBY: WAKE WORD DETECTED";
                el.core.className = "ring core listening";
            }
        } else {
            processUserCommand(transcript);
        }
    };

    state.recognition.onerror = () => {
        if (state.isSystemActive && !state.isProcessing) {
            setTimeout(() => { try { state.recognition.start(); } catch (e) {} }, 1000);
        }
    };
    state.recognition.onend = () => {
        if (state.isSystemActive && !state.isProcessing) {
            setTimeout(() => { try { state.recognition.start(); } catch (e) {} }, 500);
        }
    };
}

export function triggerManualListen() {
    el.statusDisplay.innerText = "LISTENING...";
    el.core.className = "ring core listening";
    try { state.recognition.start(); } catch (e) {}
}

export function resumeListening() {
    state.isProcessing = false;
    el.core.className = "ring core";
    el.statusDisplay.innerText = "ONLINE: LISTENING FOR VOICE...";
    if (state.isSystemActive) {
        try { state.recognition.start(); } catch (e) {}
    }
}
