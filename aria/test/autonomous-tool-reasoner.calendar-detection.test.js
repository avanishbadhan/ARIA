import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const listUpcomingCases = ["what's on my calendar", 'what is on my calendar', 'check my calendar', 'show my calendar', 'any meetings today', 'do I have any meetings this week', 'any upcoming events'];
for (const query of listUpcomingCases) {
  test(`classifies "${query}" as CALENDAR_LIST_UPCOMING`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'CALENDAR_LIST_UPCOMING');
  });
}

test('classifies "search my calendar for the budget meeting" as CALENDAR_SEARCH with the parsed query', () => {
  const decision = reasoner.evaluateIntent('search my calendar for the budget meeting');
  assert.equal(decision.toolName, 'CALENDAR_SEARCH');
  assert.equal(decision.params.query, 'the budget meeting');
});

test('classifies "find the meeting about Q3 on my calendar" as CALENDAR_SEARCH', () => {
  const decision = reasoner.evaluateIntent('find the meeting about Q3 on my calendar');
  assert.equal(decision.toolName, 'CALENDAR_SEARCH');
  assert.equal(decision.params.query, 'q3 on my calendar');
});

test('classifies "schedule a meeting called Standup for tomorrow at 9am" as CALENDAR_CREATE_EVENT', () => {
  const decision = reasoner.evaluateIntent('schedule a meeting called Standup for tomorrow at 9am');
  assert.equal(decision.toolName, 'CALENDAR_CREATE_EVENT');
  assert.equal(decision.params.title, 'standup');
  assert.equal(decision.params.when, 'tomorrow at 9am');
});

test('classifies "add an event called Dinner at 7pm" as CALENDAR_CREATE_EVENT', () => {
  const decision = reasoner.evaluateIntent('add an event called Dinner at 7pm');
  assert.equal(decision.toolName, 'CALENDAR_CREATE_EVENT');
  assert.equal(decision.params.title, 'dinner');
  assert.equal(decision.params.when, '7pm');
});

test('classifies a when-then-title reminder phrasing with a quoted title as CALENDAR_CREATE_EVENT', () => {
  const decision = reasoner.evaluateIntent('make a reminder for the 19th of august at 8am for "school starting"');
  assert.equal(decision.toolName, 'CALENDAR_CREATE_EVENT');
  assert.equal(decision.params.title, 'school starting');
  assert.equal(decision.params.when, 'the 19th of august at 8am');
});

test('classifies a title-then-when quoted-title phrasing as CALENDAR_CREATE_EVENT', () => {
  const decision = reasoner.evaluateIntent('schedule a meeting called "standup" for tomorrow at 9am');
  assert.equal(decision.toolName, 'CALENDAR_CREATE_EVENT');
  assert.equal(decision.params.title, 'standup');
  assert.equal(decision.params.when, 'tomorrow at 9am');
});

test('classifies "set up a reminder for Friday at noon for "dentist"" as CALENDAR_CREATE_EVENT', () => {
  const decision = reasoner.evaluateIntent('set up a reminder for Friday at noon for "dentist"');
  assert.equal(decision.toolName, 'CALENDAR_CREATE_EVENT');
  assert.equal(decision.params.title, 'dentist');
  assert.equal(decision.params.when, 'friday at noon');
});

const nonCalendarQueries = [
  'what is the capital of France',
  'play Cyberpunk 2077',
  'switch mode to high',
  'open gmail',
  'open spotify',
  "what's on my screen",
  'open camera',
  'check my email',
  'search my email for the invoice'
];
for (const query of nonCalendarQueries) {
  test(`does not classify "${query}" as a Calendar command`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.notEqual(decision.toolName, 'CALENDAR_LIST_UPCOMING');
    assert.notEqual(decision.toolName, 'CALENDAR_SEARCH');
    assert.notEqual(decision.toolName, 'CALENDAR_CREATE_EVENT');
  });
}
