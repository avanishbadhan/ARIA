/**
 * Tests that the cross-platform game launcher wiring routes correctly:
 * bare "launch X" goes through GameLauncherOrchestrator, "launch X on
 * xbox/epic" targets that harness directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('"launch hollow knight" routes through GameLauncherOrchestrator, not SteamHarness directly', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.gameLauncherOrchestrator.launchGame = async (query) => {
    calls.push(query);
    return { success: true, gameName: 'Hollow Knight', message: 'Launching Hollow Knight, Sir.' };
  };
  jarvis.steamHarness.launchGame = async () => { throw new Error('should not be called directly — must go through the orchestrator'); };

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('launch hollow knight');

  assert.deepEqual(calls, ['hollow knight']);
  assert.deepEqual(spoken, ['Launching, Sir.']);
});

test('"launch hades on xbox" calls XboxHarness.launchGame directly, bypassing the orchestrator', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.xboxHarness.launchGame = async (query) => { calls.push(query); return { success: true, gameName: 'Hades II', message: 'Launching Hades II on Xbox, Sir.' }; };
  jarvis.gameLauncherOrchestrator.launchGame = async () => { throw new Error('should not be called for direct targeting'); };

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('launch hades on xbox');

  assert.deepEqual(calls, ['hades']);
  assert.deepEqual(spoken, ['Launching Hades II on Xbox, Sir.']);
});

test('"launch fortnite on epic" calls EpicGamesHarness.launchGame directly, bypassing the orchestrator', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.epicGamesHarness.launchGame = async (query) => { calls.push(query); return { success: true, gameName: 'Fortnite', message: 'Launching Fortnite on Epic Games, Sir.' }; };
  jarvis.gameLauncherOrchestrator.launchGame = async () => { throw new Error('should not be called for direct targeting'); };

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('launch fortnite on epic');

  assert.deepEqual(calls, ['fortnite']);
  assert.deepEqual(spoken, ['Launching Fortnite on Epic Games, Sir.']);
});

test('a non-game query never touches the orchestrator or either new harness', async () => {
  const jarvis = createJarvis();
  jarvis.gameLauncherCalls = [];
  jarvis.gameLauncherOrchestrator.launchGame = async () => { jarvis.gameLauncherCalls.push('orchestrator'); return { success: true, message: '' }; };
  jarvis.xboxHarness.launchGame = async () => { jarvis.gameLauncherCalls.push('xbox'); return { success: true, message: '' }; };
  jarvis.epicGamesHarness.launchGame = async () => { jarvis.gameLauncherCalls.push('epic'); return { success: true, message: '' }; };

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.gameLauncherCalls.length, 0);
});

test('processUserInput passes its alternatives argument through to GameLauncherOrchestrator.launchGame', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.gameLauncherOrchestrator.launchGame = async (query, alternatives) => {
    calls.push({ query, alternatives });
    return { success: true, gameName: 'Hollow Knight', message: 'Launching Hollow Knight, Sir.' };
  };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('launch hollow knight', ['launch hallow night']);

  assert.deepEqual(calls, [{ query: 'hollow knight', alternatives: ['launch hallow night'] }]);
});

test('processUserInput defaults alternatives to an empty array when omitted (typed/manual input)', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.gameLauncherOrchestrator.launchGame = async (query, alternatives) => {
    calls.push(alternatives);
    return { success: true, gameName: 'Hollow Knight', message: 'Launching Hollow Knight, Sir.' };
  };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('launch hollow knight');

  assert.deepEqual(calls, [[]]);
});
