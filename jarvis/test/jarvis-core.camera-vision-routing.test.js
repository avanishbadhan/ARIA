import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('"open camera" opens the feed via CameraVisionHarness and speaks its message', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.cameraVisionHarness = { open: async () => { calls.push('open'); return { success: true, message: 'Camera feed active, Sir.' }; } };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('open camera');

  assert.deepEqual(calls, ['open']);
  assert.deepEqual(spoken, ['Camera feed active, Sir.']);
});

test('"close camera" closes the feed via CameraVisionHarness', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.cameraVisionHarness = { close: () => { calls.push('close'); return { success: true, message: 'Camera feed deactivated, Sir.' }; } };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('close camera');

  assert.deepEqual(calls, ['close']);
  assert.deepEqual(spoken, ['Camera feed deactivated, Sir.']);
});

test('"open camera" without a CameraVisionHarness (non-browser context) speaks an unavailable message instead of crashing', async () => {
  const jarvis = createJarvis();
  jarvis.cameraVisionHarness = null;
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('open camera');

  assert.deepEqual(spoken, ['Camera vision is not available here, Sir.']);
});

test('a non-camera query never calls the CameraVisionHarness', async () => {
  const jarvis = createJarvis();
  jarvis.cameraCalls = [];
  jarvis.cameraVisionHarness = { open: async () => { jarvis.cameraCalls.push('open'); return { success: true, message: '' }; } };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.cameraCalls.length, 0);
});
