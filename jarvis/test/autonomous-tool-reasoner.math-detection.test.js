import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const mathQueries = [
  'what is 5 plus 3',
  '12 * 8',
  'what is 45 divided by 9',
  'calculate 17 times 4',
  'what is the square root of 144',
  'solve for x: 2x + 3 = 7',
  'what is 20% of 150',
  'what is 9 squared',
  'derivative of x^2'
];

for (const query of mathQueries) {
  test(`classifies "${query}" as MATH_QUERY`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'MATH_QUERY');
    assert.equal(decision.shouldCallTool, true);
  });
}

const nonMathQueries = [
  'what is the capital of France',
  'play Cyberpunk 2077',
  'open Steam',
  'search google for quantum computing',
  'launch GTA 5',
  "what's the weather in Chicago"
];

for (const query of nonMathQueries) {
  test(`does not classify "${query}" as MATH_QUERY`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.notEqual(decision.toolName, 'MATH_QUERY');
  });
}
