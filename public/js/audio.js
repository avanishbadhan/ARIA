import { el, state } from './state.js';

export function setWaveform(active) {
    clearInterval(state.waveInterval);
    if (active) {
        state.waveInterval = setInterval(() => {
            el.waveBars.forEach(bar => {
                const h = Math.floor(Math.random() * 18) + 3;
                bar.style.height = `${h}px`;
            });
        }, 100);
    } else {
        el.waveBars.forEach(bar => bar.style.height = '4px');
    }
}

export function triggerAlarmSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const now = audioCtx.currentTime;
        for (let i = 0; i < 3; i++) {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, now + (i * 0.25));
            gain.gain.setValueAtTime(0.3, now + (i * 0.25));
            gain.gain.exponentialRampToValueAtTime(0.01, now + (i * 0.25) + 0.18);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now + (i * 0.25));
            osc.stop(now + (i * 0.25) + 0.2);
        }
    } catch (e) {}
}

export function loadVoices() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;

    while (el.voiceSelect.firstChild) {
        el.voiceSelect.removeChild(el.voiceSelect.firstChild);
    }

    const preferences = ["Google UK English Male", "Microsoft Ryan Online (Natural)", "Microsoft George", "Daniel", "en-GB", "en-US"];
    voices.forEach((voice, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `${voice.name} (${voice.lang})`;
        el.voiceSelect.appendChild(option);
    });

    for (const pref of preferences) {
        const matchIndex = voices.findIndex(v => v.name.includes(pref) || v.lang === pref);
        if (matchIndex !== -1) {
            el.voiceSelect.value = matchIndex;
            state.selectedVoice = voices[matchIndex];
            break;
        }
    }

    if (!state.selectedVoice && voices.length > 0) {
        state.selectedVoice = voices[0];
        el.voiceSelect.value = 0;
    }
}

export function updateSelectedVoice() {
    const voices = window.speechSynthesis.getVoices();
    state.selectedVoice = voices[el.voiceSelect.value];
    speak("Voice module updated.");
}

export function speak(text, callback) {
    window.speechSynthesis.cancel();

    if (el.visualPanel.classList.contains('visible')) {
        el.visualSubtitle.innerText = text;
        el.visualSubtitle.classList.add('visible');
    } else {
        el.reactorWrapper.classList.add('shifted-up');
        el.centralOverlay.innerText = text;
        el.centralOverlay.classList.add('visible');
    }

    const utterance = new SpeechSynthesisUtterance(text);
    if (state.selectedVoice) utterance.voice = state.selectedVoice;
    utterance.rate = 1.2;

    utterance.onstart = () => setWaveform(true);
    utterance.onend = () => {
        setWaveform(false);
        setTimeout(() => {
            el.centralOverlay.classList.remove('visible');
            el.visualSubtitle.classList.remove('visible');
            el.reactorWrapper.classList.remove('shifted-up');
        }, 1200);
        if (callback) callback();
    };

    window.speechSynthesis.speak(utterance);
}
