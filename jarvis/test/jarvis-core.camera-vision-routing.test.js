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

test('"how many fingers am I holding up" routes to CameraVisionHarness.askAboutCamera and speaks its answer', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.cameraVisionHarness = { askAboutCamera: async (question) => { calls.push(question); return { success: true, message: 'You are holding up three fingers, Sir.' }; } };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('how many fingers am I holding up');

  assert.deepEqual(calls, ['how many fingers am I holding up']);
  assert.deepEqual(spoken, ['You are holding up three fingers, Sir.']);
});

test('a camera-vision failure result is still spoken as-is, not treated as a crash', async () => {
  const jarvis = createJarvis();
  jarvis.cameraVisionHarness = { askAboutCamera: async () => ({ success: false, message: "I wasn't able to access the camera, Sir." }) };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('what am I holding');

  assert.deepEqual(spoken, ["I wasn't able to access the camera, Sir."]);
});

test('a camera query without a CameraVisionHarness (non-browser context) speaks an unavailable message instead of crashing', async () => {
  const jarvis = createJarvis();
  jarvis.cameraVisionHarness = null;
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('what am I holding');

  assert.deepEqual(spoken, ['Camera vision is not available here, Sir.']);
});

test('the AI intent classifier can route "open camera" to CAMERA_START (not misclassified as OPEN_SITE)', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => JSON.stringify({ toolName: 'CAMERA_START', confidence: 0.95, params: {}, reasoning: 'x' });
  const calls = [];
  jarvis.cameraVisionHarness = { open: async () => { calls.push('open'); return { success: true, message: 'Camera feed active, Sir.' }; } };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('open camera');

  assert.deepEqual(calls, ['open']);
  assert.deepEqual(spoken, ['Camera feed active, Sir.']);
});

test('a non-camera query never calls the CameraVisionHarness', async () => {
  const jarvis = createJarvis();
  jarvis.cameraCalls = [];
  jarvis.cameraVisionHarness = { open: async () => { jarvis.cameraCalls.push('open'); return { success: true, message: '' }; } };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.cameraCalls.length, 0);
});
