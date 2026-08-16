import test from 'node:test';
import assert from 'node:assert/strict';

const { LocationHarness } = await import('../src/location-harness.js');

function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function resetGeolocation() {
  setNavigator({});
}

function mockGeolocation(getCurrentPosition) {
  setNavigator({ geolocation: { getCurrentPosition } });
}

test('getCurrentPosition returns success with lat/lon when granted', async () => {
  mockGeolocation((onSuccess) => onSuccess({ coords: { latitude: 40.7128, longitude: -74.006 } }));
  const harness = new LocationHarness();
  const result = await harness.getCurrentPosition();
  assert.equal(result.success, true);
  assert.equal(result.lat, 40.7128);
  assert.equal(result.lon, -74.006);
});

test('getCurrentPosition returns a graceful message on permission denied', async () => {
  mockGeolocation((onSuccess, onError) => onError(Object.assign(new Error('denied'), { code: 1, PERMISSION_DENIED: 1 })));
  const harness = new LocationHarness();
  const result = await harness.getCurrentPosition();
  assert.equal(result.success, false);
  assert.match(result.message, /blocked location/i);
});

test('getCurrentPosition returns a distinct message on timeout', async () => {
  mockGeolocation((onSuccess, onError) => onError(Object.assign(new Error('timeout'), { code: 3, TIMEOUT: 3 })));
  const harness = new LocationHarness();
  const result = await harness.getCurrentPosition();
  assert.equal(result.success, false);
  assert.match(result.message, /couldn't lock onto your location/i);
});

test('getCurrentPosition returns a distinct message on position unavailable', async () => {
  mockGeolocation((onSuccess, onError) => onError(Object.assign(new Error('unavailable'), { code: 2, POSITION_UNAVAILABLE: 2 })));
  const harness = new LocationHarness();
  const result = await harness.getCurrentPosition();
  assert.equal(result.success, false);
  assert.match(result.message, /determine your position/i);
});

test('getCurrentPosition returns a graceful message when geolocation is unsupported', async () => {
  resetGeolocation(); // navigator.geolocation undefined
  const harness = new LocationHarness();
  const result = await harness.getCurrentPosition();
  assert.equal(result.success, false);
  assert.match(result.message, /doesn't support location/i);
});
