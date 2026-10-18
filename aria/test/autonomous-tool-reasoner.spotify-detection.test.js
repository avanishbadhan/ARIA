import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const openCases = [
  'open spotify',
  'launch spotify',
  'start spotify',
  'spotify'
];

for (const query of openCases) {
  test(`classifies "${query}" as SPOTIFY_OPEN_CLIENT`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'SPOTIFY_OPEN_CLIENT');
  });
}

const playCases = [
  ['play believer on spotify', 'believer'],
  ['spotify play imagine dragons', 'imagine dragons'],
  ['play bohemian rhapsody via spotify', 'bohemian rhapsody'],
  ['play blinding lights by the weeknd on spotify', 'blinding lights by the weeknd']
];

for (const [query, expectedQuery] of playCases) {
  test(`classifies "${query}" as SPOTIFY_PLAY_SONG -> "${expectedQuery}"`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'SPOTIFY_PLAY_SONG');
    assert.equal(decision.params.query, expectedQuery);
  });
}

test('bare "play <game>" still routes to Steam, not Spotify (regression)', () => {
  const decision = reasoner.evaluateIntent('play Cyberpunk 2077');
  assert.equal(decision.toolName, 'STEAM_LAUNCH_GAME');
});

test('bare "play <song>" without the word spotify still routes to Steam fallback', () => {
  const decision = reasoner.evaluateIntent('play believer');
  assert.notEqual(decision.toolName, 'SPOTIFY_PLAY_SONG');
});

const nonSpotifyQueries = [
  'what is the capital of France',
  'what is 5 plus 3',
  'switch mode to high',
  'open steam'
];

for (const query of nonSpotifyQueries) {
  test(`does not classify "${query}" as a Spotify tool`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.notEqual(decision.toolName, 'SPOTIFY_OPEN_CLIENT');
    assert.notEqual(decision.toolName, 'SPOTIFY_PLAY_SONG');
  });
}
