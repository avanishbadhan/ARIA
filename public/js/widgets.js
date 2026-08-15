import { el, state } from './state.js';
import { log } from './log.js';
import { triggerAlarmSound, speak } from './audio.js';

function buildCard(headerText, headerButtons, bodyNodes) {
    const card = document.createElement('div');
    card.className = 'hud-card';

    const header = document.createElement('div');
    header.className = 'hud-card-header';
    const headerSpan = document.createElement('span');
    headerSpan.textContent = headerText;
    header.appendChild(headerSpan);
    headerButtons.forEach(btn => header.appendChild(btn));

    const body = document.createElement('div');
    body.className = 'hud-card-body';
    bodyNodes.forEach(node => body.appendChild(node));

    card.appendChild(header);
    card.appendChild(body);
    return card;
}

function makeWidgetButton(text, onClick) {
    const btn = document.createElement('button');
    btn.className = 'widget-btn';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
}

function makeTimeDigits(text) {
    const div = document.createElement('div');
    div.className = 'time-digits';
    div.textContent = text;
    return div;
}

export function renderWidgetDock() {
    while (el.widgetDock.firstChild) {
        el.widgetDock.removeChild(el.widgetDock.firstChild);
    }
    let hasWidgets = false;

    if (state.stopwatch.running || state.stopwatch.elapsed > 0) {
        hasWidgets = true;
        const totalSecs = Math.floor(state.stopwatch.elapsed / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        const ms = Math.floor((state.stopwatch.elapsed % 1000) / 100);
        const digits = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;

        const card = buildCard(
            '⏱ STOPWATCH',
            [makeWidgetButton('CLEAR', stopStopwatch)],
            [makeTimeDigits(digits), makeWidgetButton(state.stopwatch.running ? 'PAUSE' : 'START', toggleStopwatchState)]
        );
        el.widgetDock.appendChild(card);
    }

    state.activeTimers.forEach((t, idx) => {
        hasWidgets = true;
        const remainingSecs = Math.max(0, Math.ceil((t.endTime - Date.now()) / 1000));
        const mins = Math.floor(remainingSecs / 60);
        const secs = remainingSecs % 60;
        const digits = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

        const card = buildCard(
            `⏳ TIMER [${t.label.toUpperCase()}]`,
            [makeWidgetButton('CANCEL', () => cancelTimer(idx))],
            [makeTimeDigits(digits)]
        );
        el.widgetDock.appendChild(card);
    });

    state.activeAlarms.forEach((a, idx) => {
        hasWidgets = true;
        const card = buildCard(
            `⏰ ALARM [${a.label.toUpperCase()}]`,
            [makeWidgetButton('DEL', () => cancelAlarm(idx))],
            [makeTimeDigits(a.timeString)]
        );
        el.widgetDock.appendChild(card);
    });

    if (hasWidgets) el.widgetDock.classList.add('active');
    else el.widgetDock.classList.remove('active');
}

export function cancelTimer(i) {
    clearTimeout(state.activeTimers[i].timeoutId);
    state.activeTimers.splice(i, 1);
    renderWidgetDock();
}

export function cancelAlarm(i) {
    state.activeAlarms.splice(i, 1);
    renderWidgetDock();
}

export function stopStopwatch() {
    state.stopwatch.running = false;
    state.stopwatch.elapsed = 0;
    renderWidgetDock();
}

export function toggleStopwatchState() {
    if (state.stopwatch.running) {
        state.stopwatch.elapsed = Date.now() - state.stopwatch.startTime;
        state.stopwatch.running = false;
    } else {
        state.stopwatch.startTime = Date.now() - state.stopwatch.elapsed;
        state.stopwatch.running = true;
    }
    renderWidgetDock();
}

export function addTimer(seconds, label = "Timer") {
    const endTime = Date.now() + seconds * 1000;
    const timeoutId = setTimeout(() => {
        triggerAlarmSound();
        log("J.A.R.V.I.S.", `Timer complete: ${label}`, "jarvis-log");
        speak(`Timer for ${label} has elapsed, sir.`);
        state.activeTimers = state.activeTimers.filter(t => t.timeoutId !== timeoutId);
        renderWidgetDock();
    }, seconds * 1000);

    state.activeTimers.push({ label, endTime, timeoutId });
    renderWidgetDock();
    return `Timer set for ${seconds} seconds.`;
}

export function addAlarm(time, label = "Alarm") {
    state.activeAlarms.push({ timeString: time, label, triggered: false });
    renderWidgetDock();
    return `Alarm set for ${time}.`;
}

export function controlStopwatch(action) {
    if (action === "start") {
        if (!state.stopwatch.running) {
            state.stopwatch.startTime = Date.now() - state.stopwatch.elapsed;
            state.stopwatch.running = true;
        }
    } else if (action === "stop") {
        if (state.stopwatch.running) {
            state.stopwatch.elapsed = Date.now() - state.stopwatch.startTime;
            state.stopwatch.running = false;
        }
    } else if (action === "reset") {
        state.stopwatch.running = false;
        state.stopwatch.elapsed = 0;
    }
    renderWidgetDock();
    return `Stopwatch ${action}ed.`;
}

export function resetWidgets() {
    state.activeTimers.forEach(t => clearTimeout(t.timeoutId));
    state.activeTimers = [];
    state.activeAlarms = [];
    state.stopwatch = { running: false, startTime: 0, elapsed: 0 };
    renderWidgetDock();
}

export function startWidgetTicker() {
    setInterval(() => {
        const now = new Date();
        const currentHHMM = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        state.activeAlarms.forEach((alarm, idx) => {
            if (alarm.timeString === currentHHMM && !alarm.triggered) {
                alarm.triggered = true;
                triggerAlarmSound();
                log("J.A.R.V.I.S.", `Alarm triggered: ${alarm.label}`, "jarvis-log");
                speak(`Alarm ringing for ${alarm.label}, sir.`);
                state.activeAlarms.splice(idx, 1);
            }
        });
        if (state.stopwatch.running) state.stopwatch.elapsed = Date.now() - state.stopwatch.startTime;
        renderWidgetDock();
    }, 200);
}
