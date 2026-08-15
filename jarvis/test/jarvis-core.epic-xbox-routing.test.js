/**
 * Tests that Epic Games / Xbox open commands are routed to their harnesses
 * and the harness's spoken message is what actually gets spoken — no LLM
 * involvement either way. Mirrors test/jarvis-core.spotify-routing.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('"open epic games" opens the app via EpicGamesHarness and speaks its message', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.epicGamesHarness.openApp = () => {
    calls.push('openApp');
    return { success: true, message: 'Opening Epic Games Launcher, Sir.' };
  };

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('open epic games');

  assert.deepEqual(calls, ['openApp']);
  assert.equal(jarvis.llmCalls.length, 0);
  assert.deepEqual(spoken, ['Opening Epic Games Launcher, Sir.']);
});

test('"open xbox" opens the app via XboxHarness and speaks its message', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.xboxHarness.openApp = () => {
    calls.push('openApp');
    return { success: true, message: 'Opening Xbox App, Sir.' };
  };

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('open xbox');

  assert.deepEqual(calls, ['openApp']);
  assert.equal(jarvis.llmCalls.length, 0);
  assert.deepEqual(spoken, ['Opening Xbox App, Sir.']);
});

test('a non-Epic/Xbox query never calls either new harness', async () => {
  const jarvis = createJarvis();
  jarvis.newHarnessCalls = [];
  jarvis.epicGamesHarness.openApp = () => { jarvis.newHarnessCalls.push('epic'); return { success: true, message: '' }; };
  jarvis.xboxHarness.openApp = () => { jarvis.newHarnessCalls.push('xbox'); return { success: true, message: '' }; };

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.newHarnessCalls.length, 0);
});
