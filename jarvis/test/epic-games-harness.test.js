import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { EpicGamesHarness } = await import('../src/epic-games-harness.js');

function resetWindow() {
  global.window = { location: { href: '' } };
}

test('openApp navigates to the com.epicgames.launcher://start URI and reports success', () => {
  resetWindow();
  const harness = new EpicGamesHarness();
  const result = harness.openApp();

  assert.equal(global.window.location.href, 'com.epicgames.launcher://start');
  assert.equal(result.success, true);
});

test('launchGame resolves via the injected EpicGamesLibrary and navigates to the com.epicgames.launcher:// URI', async () => {
  resetWindow();
  const epicGamesLibrary = {
    fetchLibrary: async () => ([{ name: 'Fortnite', appName: 'Fortnite', catalogNamespace: 'fn', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5' }]),
    findGame: (q) => (q.toLowerCase().includes('fortnite') ? { name: 'Fortnite', appName: 'Fortnite', catalogNamespace: 'fn', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5' } : null)
  };
  const harness = new EpicGamesHarness({ epicGamesLibrary });

  const result = await harness.launchGame('fortnite');

  assert.equal(result.success, true);
  assert.equal(result.gameName, 'Fortnite');
  assert.equal(global.window.location.href, 'com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true');
});

test('launchGame reports failure without navigating anywhere when no match is found', async () => {
  resetWindow();
  const epicGamesLibrary = {
    fetchLibrary: async () => ([]),
    findGame: () => null
  };
  const harness = new EpicGamesHarness({ epicGamesLibrary });

  const result = await harness.launchGame('some totally unowned title');

  assert.equal(result.success, false);
  assert.equal(global.window.location.href, '');
});

test('launchGame asks the LLM fallback when the library fuzzy-match misses, and launches its pick', async () => {
  resetWindow();
  const resolveCalls = [];
  const epicGamesLibrary = {
    fetchLibrary: async () => ([{ name: 'Fortnite', appName: 'Fortnite', catalogNamespace: 'fn', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5' }]),
    findGame: () => null // fast fuzzy-match misses
  };
  const harness = new EpicGamesHarness({
    epicGamesLibrary,
    resolveEntity: async (args) => { resolveCalls.push(args); return 'Fortnite'; }
  });

  const result = await harness.launchGame('fort night', ['fortnite']);

  assert.equal(result.success, true);
  assert.equal(result.gameName, 'Fortnite');
  assert.equal(global.window.location.href, 'com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true');
  assert.equal(resolveCalls.length, 1);
  assert.equal(resolveCalls[0].kind, 'Epic Games game to launch');
});

test('launchGame reports failure without navigating anywhere when the LLM fallback also finds nothing', async () => {
  resetWindow();
  const epicGamesLibrary = {
    fetchLibrary: async () => ([{ name: 'Fortnite', appName: 'Fortnite', catalogNamespace: 'fn', catalogItemId: 'abc' }]),
    findGame: () => null
  };
  const harness = new EpicGamesHarness({ epicGamesLibrary, resolveEntity: async () => 'NONE' });

  const result = await harness.launchGame('some totally unowned title');

  assert.equal(result.success, false);
  assert.equal(global.window.location.href, '');
});

test('launchGame does not consult resolveEntity when the library is empty', async () => {
  resetWindow();
  let called = false;
  const epicGamesLibrary = { fetchLibrary: async () => ([]), findGame: () => null };
  const harness = new EpicGamesHarness({ epicGamesLibrary, resolveEntity: async () => { called = true; return 'irrelevant'; } });

  await harness.launchGame('anything');

  assert.equal(called, false, 'no candidates exist — the LLM must not be called');
});
