import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

// "open google <property>" must hit the OPEN_SITE site map — never the broad
// Steam launch fallback ("launch game 'google docs'") nor a gaming-keyword
// hijack. Specific properties resolve to their own site; anything else
// Google-ish falls back to the generic google homepage entry.
const siteCases = [
  ['open google maps', 'maps'],
  ['go to google maps', 'maps'],
  ['show google maps', 'maps'],
  ['open google docs', 'google'],
  ['open google drive', 'google'],
  ['open google photos', 'google'],
  ['open google calendar', 'google'],
  ['open my gmail', 'gmail'],
  ['open gmail', 'gmail'],
  ['open google', 'google']
];

for (const [query, expectedSite] of siteCases) {
  test(`classifies "${query}" as OPEN_SITE -> "${expectedSite}" instead of a Steam game launch or web search`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'OPEN_SITE');
    assert.equal(decision.params.siteName, expectedSite);
  });
}
