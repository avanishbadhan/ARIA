import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('when the AI classifier returns a valid decision, it is used instead of regex', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => JSON.stringify({
    shouldCallTool: true,
    toolName: 'STEAM_LAUNCH_GAME',
    confidence: 0.9,
    params: { gameQuery: 'Balatro' },
    reasoning: 'Mis-heard "Velatro" as "Balatro".'
  });
  const calls = [];
  jarvis.gameLauncherOrchestrator.launchGame = async (gameQuery) => { calls.push(gameQuery); return { success: true, message: 'Launching, Sir.' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('lunch velatro');

  assert.deepEqual(calls, ['Balatro']);
});

test('when the AI classifier returns null, falls back to regex', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => null;
  const calls = [];
  jarvis.spotifyHarness.openApp = () => { calls.push('openApp'); return { success: true, message: 'Opening Spotify, Sir.' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('open spotify');

  assert.deepEqual(calls, ['openApp']);
});

test('when the AI classifier returns malformed JSON, falls back to regex', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => 'not json at all';
  const calls = [];
  jarvis.spotifyHarness.openApp = () => { calls.push('openApp'); return { success: true, message: 'Opening Spotify, Sir.' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('open spotify');

  assert.deepEqual(calls, ['openApp']);
});

test('when the AI classifier returns an unrecognized toolName, falls back to regex', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => JSON.stringify({ shouldCallTool: true, toolName: 'DO_SOMETHING_MADE_UP', confidence: 0.9, params: {}, reasoning: 'x' });
  const calls = [];
  jarvis.spotifyHarness.openApp = () => { calls.push('openApp'); return { success: true, message: 'Opening Spotify, Sir.' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('open spotify');

  assert.deepEqual(calls, ['openApp']);
});

test('when the AI classifier omits a required param, falls back to regex', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => JSON.stringify({ shouldCallTool: true, toolName: 'STEAM_LAUNCH_GAME', confidence: 0.9, params: {}, reasoning: 'x' });
  const calls = [];
  jarvis.gameLauncherOrchestrator.launchGame = async (gameQuery) => { calls.push(gameQuery); return { success: true, message: 'Launching, Sir.' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('launch cookie clicker');

  assert.deepEqual(calls, ['cookie clicker']);
});
