/**
 * Tests that Calendar commands are routed to GoogleCalendarHarness and the
 * harness's spoken message is what actually gets spoken — no LLM involvement
 * either way. Mirrors jarvis-core.gmail-routing.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('"what\'s on my calendar" lists upcoming events via GoogleCalendarHarness and speaks its message', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.calendarHarness.listUpcoming = async (clientId, clientSecret) => {
    calls.push({ clientId, clientSecret });
    return { success: true, events: [], message: 'You have no upcoming events, Sir.' };
  };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput("what's on my calendar");

  assert.equal(calls.length, 1);
  assert.equal(jarvis.llmCalls.length, 0);
  assert.deepEqual(spoken, ['You have no upcoming events, Sir.']);
});

test('"search my calendar for the budget meeting" calls search with the parsed query', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.calendarHarness.search = async (clientId, clientSecret, query) => {
    calls.push(query);
    return { success: true, events: [], message: `I didn't find any events matching "${query}", Sir.` };
  };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('search my calendar for the budget meeting');

  assert.deepEqual(calls, ['the budget meeting']);
  assert.deepEqual(spoken, ['I didn\'t find any events matching "the budget meeting", Sir.']);
});

test('"schedule a meeting called standup for tomorrow at 9am" calls createEvent with title and when', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.calendarHarness.createEvent = async (clientId, clientSecret, title, when) => {
    calls.push({ clientId, clientSecret, title, when });
    return { success: true, event: { title }, message: `I've scheduled '${title}' for tomorrow at 9:00 AM, Sir.` };
  };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('schedule a meeting called standup for tomorrow at 9am');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'standup');
  assert.equal(calls[0].when, 'tomorrow at 9am');
  assert.deepEqual(spoken, ["I've scheduled 'standup' for tomorrow at 9:00 AM, Sir."]);
});

test('a Calendar harness failure result is still spoken as-is, not treated as a crash', async () => {
  const jarvis = createJarvis();
  jarvis.calendarHarness.listUpcoming = async () => ({ success: false, message: "Your Google account isn't connected yet. Connect it in Settings, Sir." });
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('check my calendar');

  assert.deepEqual(spoken, ["Your Google account isn't connected yet. Connect it in Settings, Sir."]);
});

test('a non-calendar query never calls GoogleCalendarHarness', async () => {
  const jarvis = createJarvis();
  jarvis.calendarCalls = [];
  jarvis.calendarHarness.listUpcoming = async () => { jarvis.calendarCalls.push('listUpcoming'); return { success: true, message: '' }; };
  jarvis.calendarHarness.search = async () => { jarvis.calendarCalls.push('search'); return { success: true, message: '' }; };
  jarvis.calendarHarness.createEvent = async () => { jarvis.calendarCalls.push('createEvent'); return { success: true, message: '' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.calendarCalls.length, 0);
});

test('JarvisCore constructor wires a GoogleCalendarHarness instance', async () => {
  const jarvis = createJarvis();
  assert.ok(jarvis.calendarHarness);
  assert.equal(typeof jarvis.calendarHarness.listUpcoming, 'function');
  assert.equal(typeof jarvis.calendarHarness.search, 'function');
  assert.equal(typeof jarvis.calendarHarness.createEvent, 'function');
});
