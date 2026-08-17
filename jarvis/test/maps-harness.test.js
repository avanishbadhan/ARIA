import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { MapsHarness } = await import('../src/maps-harness.js');

function resetWindow() {
  global.window = {};
}

test('findNearbyPlaces returns a not-available message outside Electron', async () => {
  resetWindow();
  const harness = new MapsHarness();
  const result = await harness.findNearbyPlaces(37.7749, -122.4194, 'pizza');
  assert.equal(result.success, false);
  assert.match(result.message, /not available/i);
});

test('getDirections returns a not-available message outside Electron', async () => {
  resetWindow();
  const harness = new MapsHarness();
  const result = await harness.getDirections(37.7749, -122.4194, 'the airport');
  assert.equal(result.success, false);
  assert.match(result.message, /not available/i);
});

test('findNearbyPlaces delegates to window.jarvisElectron.maps.findNearby and maps the response', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    maps: {
      findNearby: async (lat, lon, query) => ({
        success: true,
        places: [
          { name: 'Slice House', distanceMi: 0.3, address: '123 Main St' },
          { name: 'Pizza Palace', distanceMi: 0.9, address: '45 Oak Ave' }
        ]
      })
    }
  };
  const harness = new MapsHarness();
  const result = await harness.findNearbyPlaces(37.7749, -122.4194, 'pizza');
  assert.equal(result.success, true);
  assert.equal(result.places.length, 2);
  assert.equal(result.places[0].name, 'Slice House');
  assert.equal(result.places[0].distanceMi, 0.3);
  assert.equal(result.places[0].address, '123 Main St');
});

test('findNearbyPlaces resolves a failure result to a failure message', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, maps: { findNearby: async () => ({ success: false, message: "I couldn't find anything nearby, Sir." }) } };
  const harness = new MapsHarness();
  const result = await harness.findNearbyPlaces(1, 2, 'pizza');
  assert.equal(result.success, false);
  assert.match(result.message, /couldn't find anything nearby/i);
});

test('findNearbyPlaces resolves a thrown IPC call to a failure message', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, maps: { findNearby: async () => { throw new Error('nope'); } } };
  const harness = new MapsHarness();
  const result = await harness.findNearbyPlaces(1, 2, 'pizza');
  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to reach the map service/i);
});

test('getDirections delegates to window.jarvisElectron.maps.getDirections and maps the response', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    maps: {
      getDirections: async (lat, lon, destination) => ({
        success: true,
        distanceMi: 4.2,
        durationMin: 12,
        destinationLabel: 'Airport'
      })
    }
  };
  const harness = new MapsHarness();
  const result = await harness.getDirections(37.7749, -122.4194, 'the airport');
  assert.equal(result.success, true);
  assert.equal(result.distanceMi, 4.2);
  assert.equal(result.durationMin, 12);
  assert.equal(result.destinationLabel, 'Airport');
});

test('getDirections resolves a no-match geocode to a failure message', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, maps: { getDirections: async () => ({ success: false, message: "I couldn't find that place, Sir." }) } };
  const harness = new MapsHarness();
  const result = await harness.getDirections(1, 2, 'nowhere');
  assert.equal(result.success, false);
  assert.match(result.message, /couldn't find that place/i);
});

test('getDirections resolves a thrown IPC call to a failure message', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, maps: { getDirections: async () => { throw new Error('nope'); } } };
  const harness = new MapsHarness();
  const result = await harness.getDirections(1, 2, 'the airport');
  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to reach the map service/i);
});
