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

// Conversational back-and-forth that merely contains "play" mid-sentence must
// never be inferred as a bare game launch — this hijacked replies like
// "can you see my tic tac toe on my screen, i am X. where should i play next"
// into a Steam launch for "next".
const conversationalPlayCases = [
  'where should i play next',
  'i am X. where should i play next',
  'let me think about where i should play',
  'i was about to play, wait'
];
for (const query of conversationalPlayCases) {
  test(`does NOT classify conversational "${query}" as a Steam game launch`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.notEqual(decision.toolName, 'STEAM_LAUNCH_GAME');
  });
}

// Polite-prefix play commands must still launch: the anchor allows common
// speech-to-text prefixes in front of the verb.
const politeLaunchCases = [
  ['can you play rust', 'Rust'],
  ['please play csgo', 'Counter-Strike 2'],
  ["let's play elden ring", 'Elden Ring']
];
for (const [query, expectedGame] of politeLaunchCases) {
  test(`classifies "${query}" as STEAM_LAUNCH_GAME -> "${expectedGame}" despite the prefix`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'STEAM_LAUNCH_GAME');
    assert.equal(decision.params.gameQuery, expectedGame);
  });
}
