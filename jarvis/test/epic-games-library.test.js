import test from 'node:test';
import assert from 'node:assert/strict';

global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};
global.window = global.window || {};

const { EpicGamesLibrary } = await import('../src/epic-games-library.js');

function resetWindow(overrides = {}) {
  global.window = { ...overrides };
  global.localStorage.store.clear();
}

test('fetchLibrary returns an empty array when not running in Electron', async () => {
  resetWindow();
  const lib = new EpicGamesLibrary();
  const result = await lib.fetchLibrary();
  assert.deepEqual(result, []);
});

test('fetchLibrary maps Electron IPC results into { name, nameLower, appName, catalogNamespace, catalogItemId }', async () => {
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      epicGetInstalledGames: async () => ([
        { displayName: 'Fortnite', appName: 'Fortnite', catalogNamespace: 'fn', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5' }
      ])
    }
  });
  const lib = new EpicGamesLibrary();
  const result = await lib.fetchLibrary();
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Fortnite');
  assert.equal(result[0].nameLower, 'fortnite');
  assert.equal(result[0].appName, 'Fortnite');
  assert.equal(result[0].catalogNamespace, 'fn');
  assert.equal(result[0].catalogItemId, '4fe75bbc5a674f4f9b356b5c90567da5');
});

test('fetchLibrary returns an empty array and does not throw when the IPC call rejects', async () => {
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      epicGetInstalledGames: async () => { throw new Error('manifests folder not found'); }
    }
  });
  const lib = new EpicGamesLibrary();
  const result = await lib.fetchLibrary();
  assert.deepEqual(result, []);
});

test('fetchLibrary reuses the cached result on a second call without re-invoking the IPC bridge', async () => {
  let callCount = 0;
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      epicGetInstalledGames: async () => {
        callCount++;
        return [{ displayName: 'Fortnite', appName: 'Fortnite', catalogNamespace: 'fn', catalogItemId: 'abc' }];
      }
    }
  });
  const lib = new EpicGamesLibrary();
  await lib.fetchLibrary();
  await lib.fetchLibrary();
  assert.equal(callCount, 1);
});

test('findGame fuzzy-matches against the fetched library', async () => {
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      epicGetInstalledGames: async () => ([{ displayName: 'Fortnite', appName: 'Fortnite', catalogNamespace: 'fn', catalogItemId: 'abc' }])
    }
  });
  const lib = new EpicGamesLibrary();
  await lib.fetchLibrary();
  const match = lib.findGame('fortnite');
  assert.equal(match.name, 'Fortnite');
});
