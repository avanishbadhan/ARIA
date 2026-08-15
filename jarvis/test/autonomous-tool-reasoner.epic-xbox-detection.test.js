import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const epicOpenCases = [
  'open epic games',
  'launch epic games',
  'start epic',
  'epic games',
  'epic',
  'open epic games launcher'
];

for (const query of epicOpenCases) {
  test(`classifies "${query}" as EPIC_OPEN_CLIENT`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'EPIC_OPEN_CLIENT');
  });
}

const xboxOpenCases = [
  'open xbox',
  'launch xbox app',
  'start xbox',
  'xbox'
];

for (const query of xboxOpenCases) {
  test(`classifies "${query}" as XBOX_OPEN_CLIENT`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'XBOX_OPEN_CLIENT');
  });
}

test('bare "play <game>" still routes to Steam, not Epic/Xbox (regression)', () => {
  const decision = reasoner.evaluateIntent('play Cyberpunk 2077');
  assert.equal(decision.toolName, 'STEAM_LAUNCH_GAME');
});

test('"open epic games launcher" does not fall through to the Steam broad-launch fallback', () => {
  const decision = reasoner.evaluateIntent('open epic games launcher');
  assert.equal(decision.toolName, 'EPIC_OPEN_CLIENT');
});

test('"open xbox" does not fall through to the Steam broad-launch fallback', () => {
  const decision = reasoner.evaluateIntent('open xbox');
  assert.equal(decision.toolName, 'XBOX_OPEN_CLIENT');
});

// "epic" and "xbox" are common enough substrings in real game titles and
// everyday phrases (unlike "spotify") that a loose text.includes() check
// would misroute these to EPIC_OPEN_CLIENT/XBOX_OPEN_CLIENT instead of a
// real Steam game launch or a plain conversational/search response.
test('"launch Epic Mickey" is not misrouted to EPIC_OPEN_CLIENT (routes to Steam instead)', () => {
  const decision = reasoner.evaluateIntent('launch Epic Mickey');
  assert.equal(decision.toolName, 'STEAM_LAUNCH_GAME');
});

test('"open epic mickey 2" is not misrouted to EPIC_OPEN_CLIENT (routes to Steam instead)', () => {
  const decision = reasoner.evaluateIntent('open epic mickey 2');
  assert.equal(decision.toolName, 'STEAM_LAUNCH_GAME');
});

test('"launch the new Xbox exclusive" is not misrouted to XBOX_OPEN_CLIENT', () => {
  const decision = reasoner.evaluateIntent('launch the new Xbox exclusive');
  assert.notEqual(decision.toolName, 'XBOX_OPEN_CLIENT');
});

test('"open the new Xbox exclusive game" is not misrouted to XBOX_OPEN_CLIENT', () => {
  const decision = reasoner.evaluateIntent('open the new Xbox exclusive game');
  assert.notEqual(decision.toolName, 'XBOX_OPEN_CLIENT');
});

// Regression: speech-to-text commonly appends trailing punctuation
// ("Open Xbox." rather than "open xbox"), and JARVIS's raw voice input is
// capitalized ("Open Xbox." not "open xbox") — real bug found in production
// where the anchored regex (added to fix the Epic Mickey/Xbox exclusive
// collision above) didn't tolerate a trailing period, so "Open Xbox." fell
// through to CONVERSATIONAL instead of matching XBOX_OPEN_CLIENT.
test('"Open Xbox." (capitalized, trailing period, as real STT produces) still classifies as XBOX_OPEN_CLIENT', () => {
  const decision = reasoner.evaluateIntent('Open Xbox.');
  assert.equal(decision.toolName, 'XBOX_OPEN_CLIENT');
});

test('"Open Epic Games." (capitalized, trailing period) still classifies as EPIC_OPEN_CLIENT', () => {
  const decision = reasoner.evaluateIntent('Open Epic Games.');
  assert.equal(decision.toolName, 'EPIC_OPEN_CLIENT');
});

test('"xbox!" (trailing exclamation) still classifies as XBOX_OPEN_CLIENT', () => {
  const decision = reasoner.evaluateIntent('xbox!');
  assert.equal(decision.toolName, 'XBOX_OPEN_CLIENT');
});

test('"epic." (trailing period, bare word) still classifies as EPIC_OPEN_CLIENT', () => {
  const decision = reasoner.evaluateIntent('epic.');
  assert.equal(decision.toolName, 'EPIC_OPEN_CLIENT');
});
