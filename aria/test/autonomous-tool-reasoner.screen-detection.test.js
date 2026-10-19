import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const monitorStartCases = ['start monitoring my screen', 'begin watching my screen', 'start monitoring the screen'];
for (const query of monitorStartCases) {
  test(`classifies "${query}" as SCREEN_MONITOR_START`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'SCREEN_MONITOR_START');
  });
}

const monitorStopCases = ['stop monitoring my screen', 'end watching my screen', 'stop monitoring the screen'];
for (const query of monitorStopCases) {
  test(`classifies "${query}" as SCREEN_MONITOR_STOP`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'SCREEN_MONITOR_STOP');
  });
}

const screenQueryCases = [
  "what's on my screen",
  'what is on my screen',
  'what does this say',
  'read this',
  'what am i looking at',
  'describe my screen'
];
for (const query of screenQueryCases) {
  test(`classifies "${query}" as SCREEN_QUERY with the full input as the question`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'SCREEN_QUERY');
    assert.equal(decision.params.question, query);
  });
}

const nonScreenQueries = [
  'what is the capital of France',
  'play Cyberpunk 2077',
  'switch mode to high',
  'open spotify'
];
for (const query of nonScreenQueries) {
  test(`does not classify "${query}" as a screen command`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.notEqual(decision.toolName, 'SCREEN_MONITOR_START');
    assert.notEqual(decision.toolName, 'SCREEN_MONITOR_STOP');
    assert.notEqual(decision.toolName, 'SCREEN_QUERY');
  });
}
