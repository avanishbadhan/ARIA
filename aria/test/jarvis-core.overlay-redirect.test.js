import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

function decide(jarvis, toolName, params = {}, reasoning = 'test override') {
  jarvis._classifyIntentWithAI = async () => JSON.stringify({
    shouldCallTool: true, toolName, params, confidence: 0.95, reasoning
  });
}

function stubOverlayHarness(jarvis) {
  const calls = [];
  jarvis.screenVisionHarness = {
    startOverlay: async () => { calls.push('start'); return { success: true, message: 'Overlay armed, Sir.' }; },
    stopOverlay: async () => { calls.push('stop'); return { success: true, message: 'Overlay hidden, Sir.' }; },
    startMonitoring: async () => { calls.push('monitor-start'); return { success: true, message: 'Monitoring armed.' }; },
    stopMonitoring: async () => { calls.push('monitor-stop'); return { success: true, message: 'Monitoring stopped.' }; }
  };
  return calls;
}

test('a classifier mislabeling "show screen overlay" as SCREEN_MONITOR_START is redirected to the overlay toggle', async () => {
  const jarvis = createJarvis();
  const calls = stubOverlayHarness(jarvis);
  jarvis.voiceEngine.speak = async () => {};

  decide(jarvis, 'SCREEN_MONITOR_START', {}, 'model conflated the two screen tools');
  await jarvis.processUserInput('show screen overlay');

  assert.deepEqual(calls, ['start'], 'must toggle the overlay, not arm monitoring');
});

test('SCREEN_MONITOR_START for genuine monitoring phrasing still arms monitoring', async () => {
  const jarvis = createJarvis();
  const calls = stubOverlayHarness(jarvis);
  jarvis.voiceEngine.speak = async () => {};

  decide(jarvis, 'SCREEN_MONITOR_START');
  await jarvis.processUserInput('start monitoring my screen');

  assert.equal(calls[0], 'monitor-start');
});

test('"hide screen overlay" mislabeled as SCREEN_MONITOR_STOP redirects to the overlay toggle (hides)', async () => {
  const jarvis = createJarvis();
  const calls = stubOverlayHarness(jarvis);
  jarvis.voiceEngine.speak = async () => {};

  decide(jarvis, 'SCREEN_MONITOR_STOP');
  await jarvis.processUserInput('hide screen overlay');

  assert.deepEqual(calls, ['stop'], 'must hide the overlay');
});
