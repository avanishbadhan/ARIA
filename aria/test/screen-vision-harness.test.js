import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenVisionHarness } from '../src/screen-vision-harness.js';

function resetWindow(overrides = {}) {
  global.window = {
    jarvisElectron: {
      screen: {
        capturePrimary: async () => ({ success: true, dataUrl: 'data:image/jpeg;base64,FAKE' }),
        monitorShow: async () => {},
        monitorHide: async () => {},
        ...overrides
      }
    }
  };
}

test('startMonitoring shows the indicator and flips isMonitoring on', async () => {
  const calls = [];
  resetWindow({ monitorShow: async () => { calls.push('show'); } });
  const harness = new ScreenVisionHarness();

  const result = await harness.startMonitoring();

  assert.equal(result.success, true);
  assert.equal(harness.isMonitoring, true);
  assert.deepEqual(calls, ['show']);
});

test('stopMonitoring hides the indicator and flips isMonitoring off', async () => {
  const calls = [];
  resetWindow({ monitorHide: async () => { calls.push('hide'); } });
  const harness = new ScreenVisionHarness();
  harness.isMonitoring = true;

  const result = await harness.stopMonitoring();

  assert.equal(result.success, true);
  assert.equal(harness.isMonitoring, false);
  assert.deepEqual(calls, ['hide']);
});

test('askAboutScreen captures a screenshot, asks the vision LLM, and returns its answer', async () => {
  resetWindow();
  const visionCalls = [];
  const harness = new ScreenVisionHarness({
    askVisionLLM: async (args) => { visionCalls.push(args); return 'A code editor with a red squiggly underline on line 12.'; }
  });

  const result = await harness.askAboutScreen('what does this error say');

  assert.equal(result.success, true);
  assert.equal(result.message, 'A code editor with a red squiggly underline on line 12.');
  assert.equal(visionCalls.length, 1);
  assert.equal(visionCalls[0].question, 'what does this error say');
  assert.equal(visionCalls[0].imageDataUrl, 'data:image/jpeg;base64,FAKE');
});

test('askAboutScreen flashes the indicator on/off when monitoring was not already active', async () => {
  const calls = [];
  resetWindow({
    monitorShow: async () => { calls.push('show'); },
    monitorHide: async () => { calls.push('hide'); }
  });
  const harness = new ScreenVisionHarness({ askVisionLLM: async () => 'answer' });

  await harness.askAboutScreen('what is on my screen');

  assert.deepEqual(calls, ['show', 'hide']);
});

test('two rapid askAboutScreen calls share one show/hide cycle and one capture instead of restoring early', async () => {
  const calls = [];
  let captureCount = 0;
  let releaseCapture;
  resetWindow({
    monitorShow: async () => { calls.push('show'); },
    monitorHide: async () => { calls.push('hide'); },
    capturePrimary: () => new Promise((resolve) => { captureCount++; releaseCapture = resolve; })
  });
  const harness = new ScreenVisionHarness({ askVisionLLM: async () => 'answer' });

  const first = harness.askAboutScreen('what is on my screen');
  const second = harness.askAboutScreen('and now?');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(captureCount, 1, 'only one capture is in flight');
  assert.deepEqual(calls, ['show'], 'the indicator was shown exactly once so far');

  releaseCapture({ success: true, dataUrl: 'data:image/jpeg;base64,FAKE' });
  const [r1, r2] = await Promise.all([first, second]);

  assert.deepEqual(calls, ['show', 'hide'], 'restore happens exactly once, after the shared capture finishes');
  assert.equal(r1.success, true);
  assert.equal(r2.success, true);
});

test('a later askAboutScreen after the in-flight one settles runs a fresh show/hide cycle', async () => {
  const calls = [];
  resetWindow({
    monitorShow: async () => { calls.push('show'); },
    monitorHide: async () => { calls.push('hide'); }
  });
  const harness = new ScreenVisionHarness({ askVisionLLM: async () => 'answer' });

  await harness.askAboutScreen('what is on my screen');
  await harness.askAboutScreen('and now?');

  assert.deepEqual(calls, ['show', 'hide', 'show', 'hide'], 'the guard clears once settled — no stale promise is reused');
});

test('askAboutScreen does not toggle the indicator when monitoring is already active', async () => {
  const calls = [];
  resetWindow({
    monitorShow: async () => { calls.push('show'); },
    monitorHide: async () => { calls.push('hide'); }
  });
  const harness = new ScreenVisionHarness({ askVisionLLM: async () => 'answer' });
  harness.isMonitoring = true;

  await harness.askAboutScreen('what is on my screen');

  assert.deepEqual(calls, []);
});

test('askAboutScreen returns a spoken fallback when capture fails, without calling the vision LLM', async () => {
  resetWindow({ capturePrimary: async () => ({ success: false, error: 'permission denied' }) });
  let visionCalled = false;
  const harness = new ScreenVisionHarness({ askVisionLLM: async () => { visionCalled = true; return 'x'; } });

  const result = await harness.askAboutScreen('what is on my screen');

  assert.equal(result.success, false);
  assert.equal(result.message, "I wasn't able to capture your screen, Sir.");
  assert.equal(visionCalled, false);
});

test('askAboutScreen returns a spoken fallback when no vision LLM is available', async () => {
  resetWindow();
  const harness = new ScreenVisionHarness();

  const result = await harness.askAboutScreen('what is on my screen');

  assert.equal(result.success, false);
  assert.equal(result.message, "I couldn't read your screen right now, Sir.");
});

test('askAboutScreen returns a spoken fallback when the vision LLM returns null', async () => {
  resetWindow();
  const harness = new ScreenVisionHarness({ askVisionLLM: async () => null });

  const result = await harness.askAboutScreen('what is on my screen');

  assert.equal(result.success, false);
  assert.equal(result.message, "I couldn't read your screen right now, Sir.");
});

test('askAboutScreen catches a thrown error from the vision LLM and returns a spoken fallback', async () => {
  resetWindow();
  const harness = new ScreenVisionHarness({ askVisionLLM: async () => { throw new Error('network error'); } });

  const result = await harness.askAboutScreen('what is on my screen');

  assert.equal(result.success, false);
  assert.equal(result.message, "I couldn't read your screen right now, Sir.");
});

test('startMonitoring returns a graceful message outside Electron (no jarvisElectron bridge)', async () => {
  global.window = {};
  const harness = new ScreenVisionHarness();

  const result = await harness.startMonitoring();

  assert.equal(result.success, false);
  assert.equal(harness.isMonitoring, false);
});
