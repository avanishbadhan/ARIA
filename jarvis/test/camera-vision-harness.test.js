import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraVisionHarness } from '../src/camera-vision-harness.js';

function fakeCanvas() {
  const ctx = {
    clearRect() {},
    strokeRect() {},
    fillRect() {},
    fillText() {},
    measureText: () => ({ width: 40 })
  };
  return { width: 320, height: 240, getContext: () => ctx };
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
