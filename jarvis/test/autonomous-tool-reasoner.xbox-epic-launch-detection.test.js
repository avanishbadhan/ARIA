import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const xboxLaunchCases = [
  ['launch hades on xbox', 'hades'],
  ['play hades 2 via xbox', 'hades 2'],
  ['start forza on xbox', 'forza']
];

for (const [query, expectedQuery] of xboxLaunchCases) {
  test(`classifies "${query}" as XBOX_LAUNCH_GAME -> "${expectedQuery}"`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'XBOX_LAUNCH_GAME');
    assert.equal(decision.params.gameQuery, expectedQuery);
  });
}

const epicLaunchCases = [
  ['launch fortnite on epic', 'fortnite'],
  ['play rocket league via epic games', 'rocket league'],
  ['start fortnite from epic', 'fortnite']
];

for (const [query, expectedQuery] of epicLaunchCases) {
  test(`classifies "${query}" as EPIC_LAUNCH_GAME -> "${expectedQuery}"`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'EPIC_LAUNCH_GAME');
    assert.equal(decision.params.gameQuery, expectedQuery);
  });
}

test('bare "launch <game>" (no service named) still routes to STEAM_LAUNCH_GAME (regression)', () => {
  const decision = reasoner.evaluateIntent('launch Cyberpunk 2077');
  assert.equal(decision.toolName, 'STEAM_LAUNCH_GAME');
});

test('"launch hades on xbox." (trailing period, as real STT produces) still classifies as XBOX_LAUNCH_GAME', () => {
  const decision = reasoner.evaluateIntent('launch hades on xbox.');
  assert.equal(decision.toolName, 'XBOX_LAUNCH_GAME');
  assert.equal(decision.params.gameQuery, 'hades');
});

test('"Launch Fortnite On Epic." (capitalized, trailing period) still classifies as EPIC_LAUNCH_GAME', () => {
  const decision = reasoner.evaluateIntent('Launch Fortnite On Epic.');
  assert.equal(decision.toolName, 'EPIC_LAUNCH_GAME');
  assert.equal(decision.params.gameQuery, 'fortnite');
});
