import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationMs, formatDurationMs, TimerStore } from '../src/timer-store.js';

test('parseDurationMs handles digit durations', () => {
  assert.equal(parseDurationMs('set a timer for 5 seconds'), 5000);
  assert.equal(parseDurationMs('2 minutes'), 120000);
  assert.equal(parseDurationMs('90 sec'), 90000);
  assert.equal(parseDurationMs('1.5 hours'), 5400000);
});

test('parseDurationMs handles spelled numbers and compounds', () => {
  assert.equal(parseDurationMs('five seconds'), 5000);
  assert.equal(parseDurationMs('twenty five seconds'), 25000);
  assert.equal(parseDurationMs('a minute'), 60000);
});

test('parseDurationMs sums multi-unit phrases', () => {
  assert.equal(parseDurationMs('2 minutes and 30 seconds'), 150000);
  parseDurationMs('2 minutes and 30 seconds'); // idempotence (shared regex state)
  assert.equal(parseDurationMs('2 minutes and 30 seconds'), 150000);
});

test('parseDurationMs special-cases half an hour', () => {
  assert.equal(parseDurationMs('half an hour'), 1800000);
});

test('parseDurationMs returns null when no duration exists', () => {
  assert.equal(parseDurationMs('set a timer'), null);
  assert.equal(parseDurationMs(''), null);
  assert.equal(parseDurationMs(null), null);
  assert.equal(parseDurationMs('hello world'), null);
});

test('formatDurationMs speaks a natural duration', () => {
  assert.equal(formatDurationMs(5000), '5 seconds');
  assert.equal(formatDurationMs(60000), '1 minute');
  assert.equal(formatDurationMs(150000), '2 minutes and 30 seconds');
  assert.equal(formatDurationMs(3660000), '1 hour and 1 minute');
});

test('TimerStore fires each timer exactly once and removes it', async () => {
  const fired = [];
  const store = new TimerStore({ onFired: (t) => fired.push(t) });
  store.schedule({ durationMs: 60, label: 'quick' });
  store.schedule({ durationMs: 120, label: 'slow' });

  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fired.length, 2);
  assert.equal(fired[0].label, 'quick');
  assert.equal(fired[1].label, 'slow');
  assert.equal(store.list().length, 0);
});

test('TimerStore.cancelAll prevents firing and returns the count', async () => {
  const fired = [];
  const store = new TimerStore({ onFired: (t) => fired.push(t) });
  store.schedule({ durationMs: 80 });
  store.schedule({ durationMs: 80 });
  assert.deepEqual(store.cancelAll(), 2);
  assert.deepEqual(store.cancelAll(), 0);

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fired.length, 0);
});

test('TimerStore.list reports remaining time', async () => {
  const store = new TimerStore({});
  store.schedule({ durationMs: 5000, label: 'tea' });
  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, 'tea');
  assert.ok(listed[0].remainingMs <= 5000 && listed[0].remainingMs > 3000);
});
