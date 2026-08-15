import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('"start monitoring my screen" arms monitoring via ScreenVisionHarness and speaks its message', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.screenVisionHarness.startMonitoring = async () => { calls.push('start'); return { success: true, message: 'Monitoring your screen now, Sir.' }; };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('start monitoring my screen');

  assert.deepEqual(calls, ['start']);
  assert.deepEqual(spoken, ['Monitoring your screen now, Sir.']);
});

test('"stop monitoring my screen" disarms monitoring via ScreenVisionHarness', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.screenVisionHarness.stopMonitoring = async () => { calls.push('stop'); return { success: true, message: 'Stopped monitoring, Sir.' }; };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('stop monitoring my screen');

  assert.deepEqual(calls, ['stop']);
  assert.deepEqual(spoken, ['Stopped monitoring, Sir.']);
});

test('"what\'s on my screen" routes to ScreenVisionHarness.askAboutScreen and speaks its answer', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.screenVisionHarness.askAboutScreen = async (question) => { calls.push(question); return { success: true, message: 'A terminal with a stack trace.' }; };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput("what's on my screen");

  assert.equal(calls.length, 1);
  assert.deepEqual(spoken, ['A terminal with a stack trace.']);
});

test('a screen-vision failure result is still spoken as-is, not treated as a crash', async () => {
  const jarvis = createJarvis();
  jarvis.screenVisionHarness.askAboutScreen = async () => ({ success: false, message: "I wasn't able to capture your screen, Sir." });
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('what is on my screen');

  assert.deepEqual(spoken, ["I wasn't able to capture your screen, Sir."]);
});

test('a non-screen query never calls the ScreenVisionHarness', async () => {
  const jarvis = createJarvis();
  jarvis.screenCalls = [];
  jarvis.screenVisionHarness.askAboutScreen = async () => { jarvis.screenCalls.push('ask'); return { success: true, message: '' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.screenCalls.length, 0);
});
