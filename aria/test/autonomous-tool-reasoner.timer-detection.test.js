import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const timerSetCases = [
  'set a timer for five seconds',
  'set a timer for 5 seconds',
  'set a 5 second timer',
  'start a countdown for 2 minutes',
  'make a timer for 30 seconds',
  'set the timer for 90 seconds',
  'set timer for 2 minutes and 30 seconds'
];
for (const query of timerSetCases) {
  test(`classifies "${query}" as SET_TIMER with the full input as duration`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'SET_TIMER');
    assert.equal(decision.params.duration, query);
  });
}

const timerCancelCases = ['cancel the timer', 'stop my timer', 'clear timers', 'cancel timers'];
for (const query of timerCancelCases) {
  test(`classifies "${query}" as TIMER_CANCEL`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'TIMER_CANCEL');
  });
}

test('timer chatter is never classified as setting a timer', () => {
  assert.notEqual(reasoner.evaluateIntent('how to set a timer in python').toolName, 'SET_TIMER');
  assert.notEqual(reasoner.evaluateIntent('the timer in my code runs twice').toolName, 'SET_TIMER');
  assert.notEqual(reasoner.evaluateIntent('what is a countdown timer').toolName, 'SET_TIMER');
});

const politeTimerSetCases = [
  'can you set a timer for five seconds',
  'could you set a timer for 5 seconds',
  'please set a timer for 30 seconds',
  'will you set a timer for a minute',
  // SAPI-garbled polite forms observed in real transcripts.
  'and you set a timer for 5 seconds',
  'and use a timer for five second',
  'and use a timer for five seconds'
];
for (const query of politeTimerSetCases) {
  test(`classifies the polite/garbled form "${query}" as SET_TIMER`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'SET_TIMER');
  });
}
