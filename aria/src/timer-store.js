/**
 * Real, device-local timers for ARIA.
 *
 * The chat LLM will happily claim "timer set" while scheduling nothing —
 * timers are a state-changing action, so they need an actual mechanism:
 * parse the natural-language duration into milliseconds (parseDurationMs)
 * and schedule it with TimerStore, whose onFired callback runs exactly once
 * per timer. Parsing + formatting are pure functions so they're unit-testable
 * without any timers running.
 *
 * SET_TIMER / TIMER_CANCEL are intentionally NOT grounding tools (grounding
 * tools are read-only per this repo's conventions); they are regular intent
 * dispatches wired through ai-intent-classifier.js, autonomous-tool-reasoner.js
 * and jarvis-core.js's processUserInput.
 */

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90
};

const UNIT_MS = {
  sec: 1000, second: 1000, seconds: 1000,
  min: 60000, minute: 60000, minutes: 60000,
  hr: 3600000, hour: 3600000, hours: 3600000
};

// "twenty five seconds" style compounds collapse to digits before matching.
const COMPOUND_WORDS = [
  'twenty five', 'thirty five', 'forty five', 'fifty five',
  'sixty five', 'seventy five', 'eighty five', 'ninety five'
];

const numberAlternatives = ['a', 'an', ...Object.keys(NUMBER_WORDS)].join('|');
const singleDurationRe = new RegExp(
  `\\b(${numberAlternatives}|\\d+(?:\\.\\d+)?)\\s*(sec|second|seconds|secs|min|minute|minutes|mins|hr|hour|hours|hrs)\\b`,
  'g'
);

/**
 * Parses every duration in a natural-language phrase and returns the total
 * in milliseconds, or null when the text names no duration at all. Handles
 * spelled and digit numbers, "a minute", compounds like "twenty five
 * seconds", and multi-unit phrases like "2 minutes and 30 seconds".
 */
export function parseDurationMs(text) {
  let t = String(text || '').toLowerCase().replace(/[',]/g, ' ');
  for (const [i, word] of COMPOUND_WORDS.entries()) {
    t = t.replaceAll(word, String(25 + i * 10));
  }
  if (/\bhalf\s+(?:an?\s+)?hour\b/.test(t)) return 30 * 60000;

  let total = 0;
  let match;
  singleDurationRe.lastIndex = 0;
  while ((match = singleDurationRe.exec(t)) !== null) {
    const amountText = match[1];
    const unitMs = UNIT_MS[match[2]];
    const amount = /^\d+(?:\.\d+)?$/.test(amountText)
      ? parseFloat(amountText)
      : NUMBER_WORDS[amountText] ?? (amountText === 'a' || amountText === 'an' ? 1 : null);
    if (amount === null || !Number.isFinite(amount)) continue;
    total += amount * unitMs;
  }
  return total > 0 ? Math.round(total) : null;
}

/**
 * Speaks a duration back naturally: 5000 -> "five seconds",
 * 90000 -> "a minute and a half" is overkill — the simpler digit form
 * ("1 minute, 30 seconds") is unambiguous and easier to verify.
 */
export function formatDurationMs(ms) {
  const parts = [];
  let remaining = Math.round(ms);
  const hours = Math.floor(remaining / 3600000);
  remaining -= hours * 3600000;
  const minutes = Math.floor(remaining / 60000);
  remaining -= minutes * 60000;
  const seconds = Math.round(remaining / 1000);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds || parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  return parts[parts.length - 1] === '0 second' && parts.length > 1
    ? parts.join(', ')
    : parts.join(' and ');
}

/**
 * schedule()/cancelAll()/list() over setTimeout. Each timer fires exactly
 * once (the entry is removed before onFired runs, so a fired timer can't
 * double-cancel or double-fire).
 */
export class TimerStore {
  constructor({ onFired = () => {} } = {}) {
    this._timers = new Map();
    this._nextId = 1;
    this._onFired = onFired;
  }

  schedule({ durationMs, label = '' }) {
    const id = this._nextId++;
    const endsAt = Date.now() + durationMs;
    const handle = setTimeout(() => {
      this._timers.delete(id);
      this._onFired({ id, label, endsAt, durationMs });
    }, durationMs);
    // Desktop app: don't hold the process open just for a pending timer.
    if (handle && typeof handle.unref === 'function') handle.unref();
    this._timers.set(id, { id, label, endsAt, durationMs, handle });
    return { id, label, endsAt, durationMs };
  }

  cancelAll() {
    for (const timer of this._timers.values()) clearTimeout(timer.handle);
    const count = this._timers.size;
    this._timers.clear();
    return count;
  }

  list() {
    const now = Date.now();
    return [...this._timers.values()].map(({ id, label, endsAt, durationMs }) => ({
      id, label, endsAt, durationMs,
      remainingMs: Math.max(0, endsAt - now)
    }));
  }
}
