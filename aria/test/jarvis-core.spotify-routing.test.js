/**
 * Tests that Spotify commands are routed to SpotifyHarness and the harness's
 * spoken message is what actually gets spoken — no LLM involvement either way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('"open spotify" opens the app via SpotifyHarness and speaks its message', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.spotifyHarness.openApp = () => {
    calls.push('openApp');
    return { success: true, message: 'Opening Spotify, Sir.' };
  };

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('open spotify');

  assert.deepEqual(calls, ['openApp']);
  assert.equal(jarvis.llmCalls.length, 0);
  assert.deepEqual(spoken, ['Opening Spotify, Sir.']);
});

test('"play believer on spotify" calls playSong with the parsed query and speaks its result', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.spotifyHarness.playSong = async (query, clientId, clientSecret) => {
    calls.push({ query, clientId, clientSecret });
    return { success: true, trackName: 'Believer', artist: 'Imagine Dragons', message: 'Playing "Believer" by Imagine Dragons, Sir.' };
  };

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('play believer on spotify');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'believer');
  assert.equal(jarvis.llmCalls.length, 0);
  assert.deepEqual(spoken, ['Playing "Believer" by Imagine Dragons, Sir.']);
});

test('a fallback playSong result (no match found) is still spoken as-is, not treated as an error', async () => {
  const jarvis = createJarvis();
  jarvis.spotifyHarness.playSong = async () => ({
    success: false,
    usedFallback: true,
    query: 'some obscure track',
    message: 'I\'ve opened Spotify search for "some obscure track", Sir.'
  });

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('play some obscure track on spotify');

  assert.deepEqual(spoken, ['I\'ve opened Spotify search for "some obscure track", Sir.']);
});

test('a non-Spotify query never calls the Spotify harness', async () => {
  const jarvis = createJarvis();
  jarvis.spotifyCalls = [];
  jarvis.spotifyHarness.openApp = () => { jarvis.spotifyCalls.push('openApp'); return { success: true, message: '' }; };
  jarvis.spotifyHarness.playSong = async () => { jarvis.spotifyCalls.push('playSong'); return { success: true, message: '' }; };

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.spotifyCalls.length, 0);
});

test('processUserInput passes its alternatives argument through to SpotifyHarness.playFromLibrary', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.spotifyHarness.playFromLibrary = async (args) => {
    calls.push(args);
    return { success: true, matchedName: 'Late Night Coding', message: 'Playing your playlist "Late Night Coding", Sir.' };
  };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('play my late night coding playlist', ['play my late night coating playlist']);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].alternatives, ['play my late night coating playlist']);
});
