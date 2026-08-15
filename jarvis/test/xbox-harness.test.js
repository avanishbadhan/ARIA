import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { XboxHarness } = await import('../src/xbox-harness.js');

function resetWindow(overrides = {}) {
  global.window = { location: { href: '' }, ...overrides };
}

test('openApp navigates to the xbox: URI and reports success', () => {
  resetWindow();
  const harness = new XboxHarness();
  const result = harness.openApp();

  assert.equal(global.window.location.href, 'xbox:');
  assert.equal(result.success, true);
});

test('launchGame resolves via the injected XboxLibrary and calls the Electron launch bridge', async () => {
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      xboxLaunchApp: async (appId) => { global.window.__lastLaunchedAppId = appId; return { success: true }; }
    }
  });
  const xboxLibrary = {
    fetchLibrary: async () => ([{ name: 'Hades II', appId: 'SupergiantGamesLLC.HadesII_q53c1yqmx7pha!Game' }]),
    findGame: (q) => (q.toLowerCase().includes('hades') ? { name: 'Hades II', appId: 'SupergiantGamesLLC.HadesII_q53c1yqmx7pha!Game' } : null)
  };
  const harness = new XboxHarness({ xboxLibrary });

  const result = await harness.launchGame('hades 2');

  assert.equal(result.success, true);
  assert.equal(result.gameName, 'Hades II');
  assert.equal(global.window.__lastLaunchedAppId, 'SupergiantGamesLLC.HadesII_q53c1yqmx7pha!Game');
});

test('launchGame reports failure without calling the launch bridge when no match is found', async () => {
  resetWindow({ jarvisElectron: { isElectron: true, xboxLaunchApp: async () => { throw new Error('should not be called'); } } });
  const xboxLibrary = {
    fetchLibrary: async () => ([]),
    findGame: () => null
  };
  const harness = new XboxHarness({ xboxLibrary });

  const result = await harness.launchGame('some totally unowned title');

  assert.equal(result.success, false);
});

test('launchGame reports failure when not running inside Electron, even with a match', async () => {
  resetWindow();
  const xboxLibrary = {
    fetchLibrary: async () => ([{ name: 'Hades II', appId: 'abc!Game' }]),
    findGame: () => ({ name: 'Hades II', appId: 'abc!Game' })
  };
  const harness = new XboxHarness({ xboxLibrary });

  const result = await harness.launchGame('hades 2');

  assert.equal(result.success, false);
});

test('launchGame reports failure when the Electron launch bridge itself reports failure, instead of silently claiming success', async () => {
  // Regression test: an earlier version awaited the bridge call but never
  // inspected its return value, so a real main-process failure (e.g. the
  // appId shape validation in electron/main.cjs rejecting it) would still
  // be reported to the user as a successful launch.
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      xboxLaunchApp: async () => ({ success: false })
    }
  });
  const xboxLibrary = {
    fetchLibrary: async () => ([{ name: 'Hades II', appId: 'abc!Game' }]),
    findGame: () => ({ name: 'Hades II', appId: 'abc!Game' })
  };
  const harness = new XboxHarness({ xboxLibrary });

  const result = await harness.launchGame('hades 2');

  assert.equal(result.success, false);
});

test('launchGame asks the LLM fallback when the library fuzzy-match misses, and launches its pick', async () => {
  resetWindow({
    jarvisElectron: {
      isElectron: true,
      xboxLaunchApp: async (appId) => { global.window.__lastLaunchedAppId = appId; return { success: true }; }
    }
  });
  const resolveCalls = [];
  const xboxLibrary = {
    fetchLibrary: async () => ([{ name: 'Hades II', appId: 'SupergiantGamesLLC.HadesII_q53c1yqmx7pha!Game' }]),
    findGame: () => null // fast fuzzy-match misses
  };
  const harness = new XboxHarness({
    xboxLibrary,
    resolveEntity: async (args) => { resolveCalls.push(args); return 'Hades II'; }
  });

  const result = await harness.launchGame('hades to', ['hades two']);

  assert.equal(result.success, true);
  assert.equal(result.gameName, 'Hades II');
  assert.equal(global.window.__lastLaunchedAppId, 'SupergiantGamesLLC.HadesII_q53c1yqmx7pha!Game');
  assert.equal(resolveCalls.length, 1);
  assert.equal(resolveCalls[0].kind, 'Xbox game to launch');
  assert.deepEqual(resolveCalls[0].candidates, ['Hades II']);
});

test('launchGame reports failure when the LLM fallback also finds nothing', async () => {
  resetWindow({ jarvisElectron: { isElectron: true, xboxLaunchApp: async () => { throw new Error('should not be called'); } } });
  const xboxLibrary = {
    fetchLibrary: async () => ([{ name: 'Hades II', appId: 'abc!Game' }]),
    findGame: () => null
  };
  const harness = new XboxHarness({ xboxLibrary, resolveEntity: async () => 'NONE' });

  const result = await harness.launchGame('some totally unowned title');

  assert.equal(result.success, false);
});

test('launchGame does not consult resolveEntity when the library is empty', async () => {
  resetWindow();
  let called = false;
  const xboxLibrary = { fetchLibrary: async () => ([]), findGame: () => null };
  const harness = new XboxHarness({ xboxLibrary, resolveEntity: async () => { called = true; return 'irrelevant'; } });

  await harness.launchGame('anything');

  assert.equal(called, false, 'no candidates exist — the LLM must not be called');
});
