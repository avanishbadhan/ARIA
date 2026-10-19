import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

// Informational questions that merely CONTAIN a game keyword ("rust" is the
// classic offender — also a real word) are web searches, not launch commands.
const informationalCases = [
  'what is rust',
  'how to learn rust',
  'what is elden ring',
  'tell me about rust the game',
  'how to get better at csgo'
];

for (const query of informationalCases) {
  test(`classifies "${query}" as GOOGLE_SEARCH, not a Steam game launch`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'GOOGLE_SEARCH');
    assert.notEqual(decision.toolName, 'STEAM_LAUNCH_GAME');
  });
}

// Actual launch phrasing must still resolve to the named game.
const launchCases = [
  ['play rust', 'Rust'],
  ['launch csgo', 'Counter-Strike 2'],
  ['open elden ring', 'Elden Ring'],
  ['start helldivers', 'HELLDIVERS 2'],
  ['fire up gta', 'Grand Theft Auto V']
];

for (const [query, expectedGame] of launchCases) {
  test(`classifies "${query}" as STEAM_LAUNCH_GAME -> "${expectedGame}"`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'STEAM_LAUNCH_GAME');
    assert.equal(decision.params.gameQuery, expectedGame);
  });
}
