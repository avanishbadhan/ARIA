import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraVisionHarness } from '../src/camera-vision-harness.js';

function fakeCanvas() {
  const ctx = {
    clearRect() {},
    strokeRect() {},
    fillRect() {},
    fillText() {},
    drawImage() {},
    measureText: () => ({ width: 40 })
  };
  return { width: 320, height: 240, getContext: () => ctx, toDataURL: () => 'data:image/jpeg;base64,FAKEFRAME' };
}

function fakeVideo() {
  return { srcObject: null, videoWidth: 640, videoHeight: 480 };
}

function fakeTracks() {
  const stopped = [];
  return {
    stream: { getTracks: () => [{ stop: () => stopped.push('stopped') }] },
    stopped
  };
}

function makeHarness(overrides = {}) {
  const { stream } = fakeTracks();
  const rafCallbacks = [];
  return {
    harness: new CameraVisionHarness({
      videoEl: fakeVideo(),
      canvasEl: fakeCanvas(),
      panelEl: { classList: { add() {}, remove() {} } },
      mediaDevices: { getUserMedia: async () => stream },
      loadModel: async () => ({ detect: async () => [] }),
      requestAnimationFrame: (fn) => { rafCallbacks.push(fn); return rafCallbacks.length; },
      cancelAnimationFrame: () => {},
      createElement: () => fakeCanvas(),
      delay: async () => {},
      ...overrides
    }),
    rafCallbacks
  };
}

test('open() acquires the camera stream, attaches it to the video element, and flips isOpen on', async () => {
  const { harness } = makeHarness();

  const result = await harness.open();

  assert.equal(result.success, true);
  assert.equal(harness.isOpen, true);
  assert.equal(harness.videoEl.srcObject, harness.stream);
});

test('open() is a no-op success when already open', async () => {
  const { harness } = makeHarness();
  await harness.open();
  const openCalls = [];
  harness.mediaDevices.getUserMedia = async () => { openCalls.push('called'); return { getTracks: () => [] }; };

  const result = await harness.open();

  assert.equal(result.success, true);
  assert.deepEqual(openCalls, [], 'getUserMedia is not called again while already open');
});

test('open() reports failure gracefully when getUserMedia is unavailable', async () => {
  const { harness } = makeHarness({ mediaDevices: undefined });

  const result = await harness.open();

  assert.equal(result.success, false);
  assert.equal(harness.isOpen, false);
});

test('open() reports failure gracefully when getUserMedia rejects (permission denied)', async () => {
  const { harness } = makeHarness({
    mediaDevices: { getUserMedia: async () => { throw new Error('Permission denied'); } }
  });

  const result = await harness.open();

  assert.equal(result.success, false);
  assert.equal(harness.isOpen, false);
});

test('close() stops all stream tracks, detaches the video element, and flips isOpen off', async () => {
  const { harness } = makeHarness();
  await harness.open();
  const stoppedTracks = [];
  harness.stream.getTracks = () => [{ stop: () => stoppedTracks.push('stopped') }];

  const result = harness.close();

  assert.equal(result.success, true);
  assert.equal(harness.isOpen, false);
  assert.equal(harness.videoEl.srcObject, null);
  assert.deepEqual(stoppedTracks, ['stopped']);
});

test('toggle() opens when closed and closes when open', async () => {
  const { harness } = makeHarness();

  await harness.toggle();
  assert.equal(harness.isOpen, true);

  await harness.toggle();
  assert.equal(harness.isOpen, false);
});

test('open() loads the detection model once and starts the detection loop', async () => {
  const loadCalls = [];
  const { harness, rafCallbacks } = makeHarness({
    loadModel: async () => { loadCalls.push('loaded'); return { detect: async () => [] }; }
  });

  await harness.open();

  assert.deepEqual(loadCalls, ['loaded']);
  assert.equal(harness.isDetecting, true);
  assert.equal(rafCallbacks.length, 1, 'the detection loop scheduled its first frame');
});

test('open() tolerates the detection model failing to load — camera still opens', async () => {
  const { harness } = makeHarness({
    loadModel: async () => { throw new Error('WebGL not supported'); }
  });

  const result = await harness.open();

  assert.equal(result.success, true);
  assert.equal(harness.isOpen, true);
  assert.equal(harness.model, null);
});

test('close() cancels the pending animation frame and stops the detection loop', async () => {
  const cancelled = [];
  const { harness } = makeHarness({ cancelAnimationFrame: (id) => cancelled.push(id) });
  await harness.open();

  harness.close();

  assert.equal(harness.isDetecting, false);
  assert.deepEqual(cancelled, [harness.animId]);
});

test('askAboutCamera opens the camera, captures a frame, asks the vision LLM, and returns its answer', async () => {
  const visionCalls = [];
  const { harness } = makeHarness({
    askVisionLLM: async (args) => { visionCalls.push(args); return 'You are holding up three fingers, Sir.'; }
  });

  const result = await harness.askAboutCamera('how many fingers am I holding up');

  assert.equal(result.success, true);
  assert.equal(result.message, 'You are holding up three fingers, Sir.');
  assert.equal(visionCalls.length, 1);
  assert.equal(visionCalls[0].question, 'how many fingers am I holding up');
  assert.equal(visionCalls[0].source, 'camera');
  assert.equal(visionCalls[0].imageDataUrl, 'data:image/jpeg;base64,FAKEFRAME');
});

test('askAboutCamera closes the camera again afterward if it had to open it for this call', async () => {
  const { harness } = makeHarness({ askVisionLLM: async () => 'answer' });

  await harness.askAboutCamera('what am I holding');

  assert.equal(harness.isOpen, false, 'camera is closed again since it was not already open');
});

test('askAboutCamera leaves the camera open afterward if it was already open before the call', async () => {
  const { harness } = makeHarness({ askVisionLLM: async () => 'answer' });
  await harness.open();

  await harness.askAboutCamera('what am I holding');

  assert.equal(harness.isOpen, true, 'camera stays open since the caller had it open already');
});

test('askAboutCamera reports failure gracefully when no vision-capable LLM is configured', async () => {
  const { harness } = makeHarness(); // no askVisionLLM injected

  const result = await harness.askAboutCamera('what am I holding');

  assert.equal(result.success, false);
});

test('askAboutCamera reports failure gracefully when the camera itself fails to open', async () => {
  const { harness } = makeHarness({
    mediaDevices: { getUserMedia: async () => { throw new Error('Permission denied'); } },
    askVisionLLM: async () => 'should not be called'
  });

  const result = await harness.askAboutCamera('what am I holding');

  assert.equal(result.success, false);
});

test('askAboutCamera reports failure gracefully when the video never produces a frame', async () => {
  const { harness } = makeHarness({
    videoEl: { srcObject: null, videoWidth: 0, videoHeight: 0 },
    askVisionLLM: async () => 'should not be called'
  });

  const result = await harness.askAboutCamera('what am I holding');

  assert.equal(result.success, false);
});

test('two rapid open() calls share a single acquisition instead of double-acquiring streams', async () => {
  let gumCalls = 0;
  let release;
  const { harness } = makeHarness({
    mediaDevices: {
      getUserMedia: () => new Promise((resolve) => { gumCalls++; release = resolve; })
    }
  });

  const first = harness.open();
  const second = harness.open();

  assert.equal(gumCalls, 1, 'getUserMedia runs once for both concurrent callers');
  release({ getTracks: () => [] });
  const [r1, r2] = await Promise.all([first, second]);

  assert.equal(r1.success, true);
  assert.equal(r2.success, true);
  assert.equal(harness.isOpen, true);
});

test('open() stops freshly acquired tracks instead of leaking them when a post-acquisition step fails', async () => {
  const stopped = [];
  const brokenVideo = {};
  Object.defineProperty(brokenVideo, 'srcObject', {
    set() { throw new Error('srcObject attach failed'); },
    get() { return null; }
  });
  const { harness } = makeHarness({
    videoEl: brokenVideo,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push('stopped') }] }) }
  });

  const result = await harness.open();

  assert.equal(result.success, false);
  assert.deepEqual(stopped, ['stopped'], 'the just-acquired stream was released');
  assert.equal(harness.stream, null);
  assert.equal(harness.isOpen, false);
});

test('a third open() after the in-flight one settles acquires again normally', async () => {
  let gumCalls = 0;
  let release;
  const { harness } = makeHarness({
    mediaDevices: {
      getUserMedia: () => new Promise((resolve) => { gumCalls++; release = resolve; })
    }
  });

  const first = harness.open();
  const second = harness.open();
  release({ getTracks: () => [] });
  await Promise.all([first, second]);
  harness.close();

  const third = harness.open();
  assert.equal(gumCalls, 2, 'the guard is cleared once settled — no stale promise is returned');
  release({ getTracks: () => [] });
  await third;
  assert.equal(harness.isOpen, true);
});
