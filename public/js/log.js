import { el } from './state.js';

export function log(sender, message, type) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerText = `${sender}: ${message}`;
    el.consoleLog.appendChild(entry);
    el.consoleLog.scrollTop = el.consoleLog.scrollHeight;
}
