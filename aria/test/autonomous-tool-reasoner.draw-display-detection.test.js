import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const drawCases = [
  ['draw a solar system', 'a solar system'],
  ['draw me a cat', 'a cat'],
  ['sketch the water cycle', 'the water cycle'],
  ['can you draw me a diagram of the internet', 'a diagram of the internet'],
  ['draw out 2 plus 2 for me', '2 plus 2'],
  ['diagram the request flow', 'the request flow'],
  ['please draw a map of europe', 'a map of europe'],
  ['and you can draw the architecture for me', 'the architecture']
];
for (const [query, subject] of drawCases) {
  test(`classifies "${query}" as DRAW_DISPLAY with subject "${subject}"`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'DRAW_DISPLAY');
    assert.equal(decision.params.subject, subject);
  });
}

test('classifies a bare "draw something out for me" as DRAW_DISPLAY', () => {
  const decision = reasoner.evaluateIntent('draw something out for me');
  assert.equal(decision.toolName, 'DRAW_DISPLAY');
  assert.ok(decision.params.subject.length > 0);
});

test('cleaner turns on/off phrasing is still DRAW_DISPLAY without the tail in the subject', () => {
  const decision = reasoner.evaluateIntent('draw a rocket on the display');
  assert.equal(decision.toolName, 'DRAW_DISPLAY');
  assert.equal(decision.params.subject, 'a rocket');
});

test('learning questions about drawings are NOT routed to the display', () => {
  assert.notEqual(reasoner.evaluateIntent('how to draw a face').toolName, 'DRAW_DISPLAY');
  assert.notEqual(reasoner.evaluateIntent('what is a diagram').toolName, 'DRAW_DISPLAY');
  assert.notEqual(reasoner.evaluateIntent('why does the chart show that').toolName, 'DRAW_DISPLAY');
});

test('pure math phrasing without a draw verb still reaches MATH_QUERY', () => {
  assert.equal(reasoner.evaluateIntent('what is 5 plus 3').toolName, 'MATH_QUERY');
  assert.equal(reasoner.evaluateIntent('solve for x in 2x = 8').toolName, 'MATH_QUERY');
});

test('web search phrasing without a draw verb is untouched', () => {
  assert.equal(reasoner.evaluateIntent('what is the capital of France').toolName, 'GOOGLE_SEARCH');
});
