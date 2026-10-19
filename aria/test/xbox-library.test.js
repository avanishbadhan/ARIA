import test from 'node:test';
import assert from 'node:assert/strict';

global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};
global.window = global.window || {};

const { XboxLibrary } = await import('../src/xbox-library.js');

function resetWindow(overrides = {}) {
  global.window = { ...overrides };
  global.localStorage.store.clear();
}

test('fetchLibrary returns an empty array when not running in Electron', async () => {
  resetWindow();
  const lib = new XboxLibrary();
  const result = await lib.fetchLibrary();
  assert.deepEqual(result, []);
});

test('fetchLibrary maps Electron IPC results into { name, nameLower, appId }', async () => {
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      xboxGetInstalledGames: async () => ([{ name: 'Hades II', appId: 'SupergiantGamesLLC.HadesII_q53c1yqmx7pha!Game' }])
    }
  });
  const lib = new XboxLibrary();
  const result = await lib.fetchLibrary();
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Hades II');
  assert.equal(result[0].nameLower, 'hades ii');
  assert.equal(result[0].appId, 'SupergiantGamesLLC.HadesII_q53c1yqmx7pha!Game');
});

test('fetchLibrary returns an empty array and does not throw when the IPC call rejects', async () => {
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      xboxGetInstalledGames: async () => { throw new Error('powershell timed out'); }
    }
  });
  const lib = new XboxLibrary();
  const result = await lib.fetchLibrary();
  assert.deepEqual(result, []);
});

test('fetchLibrary reuses the cached result on a second call without re-invoking the IPC bridge', async () => {
  let callCount = 0;
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      xboxGetInstalledGames: async () => {
        callCount++;
        return [{ name: 'Hades II', appId: 'abc!Game' }];
      }
    }
  });
  const lib = new XboxLibrary();
  await lib.fetchLibrary();
  await lib.fetchLibrary();
  assert.equal(callCount, 1);
});

test('findGame fuzzy-matches against the fetched library', async () => {
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      xboxGetInstalledGames: async () => ([{ name: 'Hades II', appId: 'abc!Game' }])
    }
  });
  const lib = new XboxLibrary();
  await lib.fetchLibrary();
  const match = lib.findGame('hades 2');
  assert.equal(match.name, 'Hades II');
});
