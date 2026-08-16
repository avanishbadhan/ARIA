import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const browserOpenCases = [
  'open my browser',
  'open the browser',
  'open browser',
  'start browser',
  'launch browser',
  'open a tab',
  'open a new tab'
];

for (const query of browserOpenCases) {
  test(`classifies "${query}" as OPEN_SITE (browser) instead of a game launch`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'OPEN_SITE');
    assert.equal(decision.params.siteName, 'browser');
  });
}

const tabTopicCases = [
  ['open a new tab with specifics on oil production by country', 'specifics on oil production by country'],
  ['open a new tab about the weather', 'the weather']
];

for (const [query, expectedQuery] of tabTopicCases) {
  test(`classifies "${query}" as GOOGLE_SEARCH for "${expectedQuery}"`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'GOOGLE_SEARCH');
    assert.equal(decision.params.query, expectedQuery);
  });
}
