import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const tierCases = [
  ['switch mode to high', 'high'],
  ['set mode to max', 'ultra'],
  ['switch to medium mode', 'medium'],
  ['change mode to low', 'quick'],
  ['switch model to ultra', 'ultra'],
  ['set tier to mid', 'medium']
];

for (const [query, expectedTier] of tierCases) {
  test(`classifies "${query}" as SET_MODEL_TIER -> ${expectedTier}`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'SET_MODEL_TIER');
    assert.equal(decision.params.tier, expectedTier);
  });
}

test('an unrecognized tier word falls through instead of matching', () => {
  const decision = reasoner.evaluateIntent('switch mode to insane');
  assert.notEqual(decision.toolName, 'SET_MODEL_TIER');
});

const nonTierQueries = [
  'high five',
  'what is the capital of France',
  'play Cyberpunk 2077',
  'what is 5 plus 3'
];

for (const query of nonTierQueries) {
  test(`does not classify "${query}" as SET_MODEL_TIER`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.notEqual(decision.toolName, 'SET_MODEL_TIER');
  });
}
