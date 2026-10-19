import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};
global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};

const { SteamHarness } = await import('../src/steam-harness.js');

function resetWindow() {
  global.window = { location: { href: '' }, open: () => {} };
}

test('resolveGame returns a steam_library match when the configured library has it', async () => {
  resetWindow();
  const harness = new SteamHarness();
  harness.steamLibrary = {
    isConfigured: () => true,
    library: [{ appid: '570', name: 'Dota 2', nameLower: 'dota 2' }],
    fetchLibrary: async () => {},
    findGame: (q) => (q.toLowerCase().includes('dota') ? { appid: '570', name: 'Dota 2' } : null)
  };

  const resolved = await harness.resolveGame('dota');
  assert.deepEqual(resolved, { appId: '570', name: 'Dota 2', source: 'steam_library' });
});

test('resolveGame falls back to the hardcoded dictionary when the library has no match', async () => {
  resetWindow();
  const harness = new SteamHarness();
  harness.steamLibrary = { isConfigured: () => false };

  const resolved = await harness.resolveGame('dota 2');
  assert.equal(resolved.source, 'dict');
  assert.equal(resolved.appId, '570');
});

test('resolveGame returns null when nothing matches anywhere', async () => {
  resetWindow();
  const harness = new SteamHarness();
  harness.steamLibrary = { isConfigured: () => false };

  const resolved = await harness.resolveGame('some totally unowned unreleased title');
  assert.equal(resolved, null);
});

test('launchGame uses resolveGame and navigates to steam://run/<appId> on a dict match', async () => {
  resetWindow();
  const logs = [];
  const harness = new SteamHarness({ onLog: (logData) => logs.push(logData) });
  harness.steamLibrary = { isConfigured: () => false };

  const result = await harness.launchGame('dota 2');
  assert.equal(result.success, true);
  assert.equal(result.appId, '570');
  assert.equal(result.source, 'dict');
  assert.equal(result.message, 'Launching Dota 2 on Steam, Sir.');
  assert.equal(global.window.location.href, 'steam://run/570');
  assert.ok(logs.some((l) => l.message.includes('[STEAM DICT MATCH]')), 'expected a [STEAM DICT MATCH] log entry');
});

test('launchGame uses resolveGame and navigates to steam://run/<appId> on a steam_library match, with the library-specific message and log text', async () => {
  resetWindow();
  const logs = [];
  const harness = new SteamHarness({ onLog: (logData) => logs.push(logData) });
  harness.steamLibrary = {
    isConfigured: () => true,
    library: [{ appid: '570', name: 'Dota 2', nameLower: 'dota 2' }],
    fetchLibrary: async () => {},
    findGame: (q) => (q.toLowerCase().includes('dota') ? { appid: '570', name: 'Dota 2' } : null)
  };

  const result = await harness.launchGame('dota');
  assert.equal(result.success, true);
  assert.equal(result.appId, '570');
  assert.equal(result.source, 'steam_library');
  assert.equal(result.message, 'Launching Dota 2, Sir.');
  assert.equal(global.window.location.href, 'steam://run/570');
  assert.ok(logs.some((l) => l.message.includes('[STEAM LIBRARY MATCH]')), 'expected a [STEAM LIBRARY MATCH] log entry');
});

test('launchGame falls back to the Steam Store search when resolveGame finds nothing', async () => {
  resetWindow();
  let openedUrl = null;
  global.window.open = (url) => { openedUrl = url; };
  const harness = new SteamHarness();
  harness.steamLibrary = { isConfigured: () => false };

  const result = await harness.launchGame('some totally unowned unreleased title');
  assert.equal(result.success, false);
  assert.ok(openedUrl.startsWith('https://store.steampowered.com/search/?term='));
});

test('resolveGame asks the LLM fallback when the library fuzzy-match misses, and uses its pick', async () => {
  resetWindow();
  const resolveCalls = [];
  const harness = new SteamHarness({
    resolveEntity: async (args) => { resolveCalls.push(args); return 'Elden Ring'; }
  });
  harness.steamLibrary = {
    isConfigured: () => true,
    library: [{ appid: '1245620', name: 'Elden Ring', nameLower: 'elden ring' }],
    fetchLibrary: async () => {},
    findGame: () => null // fast fuzzy-match always misses in this test
  };

  const resolved = await harness.resolveGame('eldn ring', ['eldon ring']);

  assert.deepEqual(resolved, { appId: '1245620', name: 'Elden Ring', source: 'steam_library' });
  assert.equal(resolveCalls.length, 1);
  assert.equal(resolveCalls[0].query, 'eldn ring');
  assert.deepEqual(resolveCalls[0].alternatives, ['eldon ring']);
  assert.deepEqual(resolveCalls[0].candidates, ['Elden Ring']);
  assert.equal(resolveCalls[0].kind, 'Steam game to launch');
});

test('resolveGame falls through to the dict when the LLM fallback returns NONE', async () => {
  resetWindow();
  const harness = new SteamHarness({ resolveEntity: async () => 'NONE' });
  harness.steamLibrary = {
    isConfigured: () => true,
    library: [{ appid: '1245620', name: 'Elden Ring', nameLower: 'elden ring' }],
    fetchLibrary: async () => {},
    findGame: () => null
  };

  const resolved = await harness.resolveGame('dota 2');

  assert.equal(resolved.source, 'dict');
  assert.equal(resolved.appId, '570');
});

test('resolveGame returns null when the LLM answer is not one of the real candidates', async () => {
  resetWindow();
  const harness = new SteamHarness({ resolveEntity: async () => 'Some Made Up Game' });
  harness.steamLibrary = {
    isConfigured: () => true,
    library: [{ appid: '1245620', name: 'Elden Ring', nameLower: 'elden ring' }],
    fetchLibrary: async () => {},
    findGame: () => null
  };

  const resolved = await harness.resolveGame('some totally unowned title');

  assert.equal(resolved, null);
});

test('resolveGame never calls resolveEntity when the fast fuzzy-match already hit', async () => {
  resetWindow();
  let called = false;
  const harness = new SteamHarness({ resolveEntity: async () => { called = true; return 'irrelevant'; } });
  harness.steamLibrary = {
    isConfigured: () => true,
    library: [{ appid: '570', name: 'Dota 2', nameLower: 'dota 2' }],
    fetchLibrary: async () => {},
    findGame: (q) => (q.toLowerCase().includes('dota') ? { appid: '570', name: 'Dota 2' } : null)
  };

  await harness.resolveGame('dota');

  assert.equal(called, false, 'the fast path already matched — the LLM fallback must not be consulted');
});

test('resolveGame never calls resolveEntity when skipLlmFallback is passed, even on a fast-match miss', async () => {
  resetWindow();
  let called = false;
  const harness = new SteamHarness({ resolveEntity: async () => { called = true; return 'Terraria'; } });
  harness.steamLibrary = {
    isConfigured: () => true,
    library: [{ appid: '105600', name: 'Terraria', nameLower: 'terraria' }],
    fetchLibrary: async () => {},
    findGame: () => null
  };

  const resolved = await harness.resolveGame('velatro', [], { skipLlmFallback: true });

  assert.equal(called, false, 'skipLlmFallback must suppress the LLM fallback entirely');
  assert.equal(resolved, null);
});

test('launchGame forwards its options argument (e.g. skipLlmFallback) through to resolveGame', async () => {
  resetWindow();
  let called = false;
  const harness = new SteamHarness({ resolveEntity: async () => { called = true; return 'Terraria'; } });
  harness.steamLibrary = {
    isConfigured: () => true,
    library: [{ appid: '105600', name: 'Terraria', nameLower: 'terraria' }],
    fetchLibrary: async () => {},
    findGame: () => null
  };

  await harness.launchGame('velatro', [], { skipLlmFallback: true });

  assert.equal(called, false, 'launchGame must pass skipLlmFallback through to resolveGame');
});
