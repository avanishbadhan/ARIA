import test from 'node:test';
import assert from 'node:assert/strict';
import { GameLauncherOrchestrator } from '../src/game-launcher-orchestrator.js';

function makeOrchestrator({ steamMatch, xboxGames, xboxMatch, epicGames, epicMatch }) {
  const calls = [];
  const steamHarness = {
    resolveGame: async (q) => { calls.push(`steam.resolveGame(${q})`); return steamMatch; },
    launchGame: async (q) => { calls.push(`steam.launchGame(${q})`); return { success: true, gameName: q, source: 'steam' }; }
  };
  const xboxLibrary = {
    fetchLibrary: async () => { calls.push('xbox.fetchLibrary'); return xboxGames || []; },
    findGame: (q) => { calls.push(`xbox.findGame(${q})`); return xboxMatch || null; }
  };
  const epicGamesLibrary = {
    fetchLibrary: async () => { calls.push('epic.fetchLibrary'); return epicGames || []; },
    findGame: (q) => { calls.push(`epic.findGame(${q})`); return epicMatch || null; }
  };
  const xboxHarness = { launchGame: async (q) => { calls.push(`xbox.launchGame(${q})`); return { success: true, gameName: q, source: 'xbox' }; } };
  const epicGamesHarness = { launchGame: async (q) => { calls.push(`epic.launchGame(${q})`); return { success: true, gameName: q, source: 'epic' }; } };

  const orchestrator = new GameLauncherOrchestrator({ steamHarness, xboxHarness, epicGamesHarness, xboxLibrary, epicGamesLibrary });
  return { orchestrator, calls };
}

test('a Steam match stops the chain immediately — Xbox and Epic are never consulted', async () => {
  const { orchestrator, calls } = makeOrchestrator({ steamMatch: { appId: '570', name: 'Dota 2', source: 'steam_library' } });

  const result = await orchestrator.launchGame('dota 2');

  assert.equal(result.source, 'steam');
  assert.deepEqual(calls, ['steam.resolveGame(dota 2)', 'steam.launchGame(dota 2)']);
});

test('a Steam miss + Xbox match launches via Xbox — Epic is never consulted', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    steamMatch: null,
    xboxGames: [{ name: 'Hades II' }],
    xboxMatch: { name: 'Hades II', appId: 'abc!Game' }
  });

  const result = await orchestrator.launchGame('hades 2');

  assert.equal(result.source, 'xbox');
  assert.deepEqual(calls, ['steam.resolveGame(hades 2)', 'xbox.fetchLibrary', 'xbox.findGame(hades 2)', 'xbox.launchGame(hades 2)']);
});

test('a Steam + Xbox miss + Epic match launches via Epic', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    steamMatch: null,
    xboxGames: [],
    epicGames: [{ name: 'Fortnite' }],
    epicMatch: { name: 'Fortnite' }
  });

  const result = await orchestrator.launchGame('fortnite');

  assert.equal(result.source, 'epic');
  assert.deepEqual(calls, ['steam.resolveGame(fortnite)', 'xbox.fetchLibrary', 'epic.fetchLibrary', 'epic.findGame(fortnite)', 'epic.launchGame(fortnite)']);
});

test('a miss everywhere falls through to steamHarness.launchGame (its own Store-search fallback)', async () => {
  const { orchestrator, calls } = makeOrchestrator({ steamMatch: null, xboxGames: [], epicGames: [] });

  const result = await orchestrator.launchGame('some totally unowned title');

  assert.equal(result.source, 'steam');
  assert.deepEqual(calls, [
    'steam.resolveGame(some totally unowned title)',
    'xbox.fetchLibrary',
    'epic.fetchLibrary',
    'steam.launchGame(some totally unowned title)'
  ]);
});

test('an empty (non-null) Xbox library skips straight to fetching Epic without calling xbox.findGame', async () => {
  const { orchestrator, calls } = makeOrchestrator({ steamMatch: null, xboxGames: [], epicGames: [{ name: 'Fortnite' }], epicMatch: { name: 'Fortnite' } });

  await orchestrator.launchGame('fortnite');

  assert.ok(!calls.includes('xbox.findGame(fortnite)'), 'should not call findGame against an empty library');
});

function makeOrchestratorWithFallback({ steamLibraryGames = [], xboxGames = [], epicGames = [], resolveEntity, steamResolveGameResult = null }) {
  const calls = [];
  const resolveGameCalls = [];
  const launchGameCalls = [];
  const steamHarness = {
    steamLibrary: { library: steamLibraryGames },
    resolveGame: async (q, alts, options) => { calls.push(`steam.resolveGame(${q})`); resolveGameCalls.push({ q, alts, options }); return steamResolveGameResult; },
    launchGame: async (q, alts, options) => { calls.push(`steam.launchGame(${q})`); launchGameCalls.push({ q, alts, options }); return { success: false, gameName: q, message: `not found: ${q}` }; }
  };
  const xboxLibrary = {
    fetchLibrary: async () => { calls.push('xbox.fetchLibrary'); return xboxGames; },
    findGame: (q) => { calls.push(`xbox.findGame(${q})`); return null; }
  };
  const epicGamesLibrary = {
    fetchLibrary: async () => { calls.push('epic.fetchLibrary'); return epicGames; },
    findGame: (q) => { calls.push(`epic.findGame(${q})`); return null; }
  };
  const xboxHarness = { launchGame: async (q) => { calls.push(`xbox.launchGame(${q})`); return { success: true, gameName: q, source: 'xbox' }; } };
  const epicGamesHarness = { launchGame: async (q) => { calls.push(`epic.launchGame(${q})`); return { success: true, gameName: q, source: 'epic' }; } };

  const orchestrator = new GameLauncherOrchestrator({ steamHarness, xboxHarness, epicGamesHarness, xboxLibrary, epicGamesLibrary, resolveEntity });
  return { orchestrator, calls, resolveGameCalls, launchGameCalls };
}

test('the initial Steam existence-check skips SteamHarness\'s own LLM fallback, so a plausible-but-wrong Steam guess never short-circuits the chain before Xbox/Epic are considered', async () => {
  const resolveCalls = [];
  const { orchestrator, resolveGameCalls } = makeOrchestratorWithFallback({
    steamLibraryGames: [{ name: 'Terraria' }],
    xboxGames: [{ name: 'Balatro' }],
    epicGames: [],
    resolveEntity: async (args) => { resolveCalls.push(args); return 'Balatro'; }
  });

  const result = await orchestrator.launchGame('velatro');

  assert.equal(resolveGameCalls[0].options?.skipLlmFallback, true, 'the orchestrator\'s existence-check must ask SteamHarness to skip its own LLM fallback');
  assert.equal(result.success, true);
  assert.equal(result.gameName, 'Balatro');
  assert.equal(result.source, 'xbox');
  // Only the combined, cross-platform call should have consulted the LLM — never a Steam-only one.
  assert.equal(resolveCalls.length, 1);
  assert.deepEqual(resolveCalls[0].candidates, ['Terraria', 'Balatro']);
});

test('the terminal Steam Store-search fallback also skips SteamHarness\'s own LLM fallback, since the combined cross-platform call already had its shot', async () => {
  const { orchestrator, resolveGameCalls, launchGameCalls } = makeOrchestratorWithFallback({
    steamLibraryGames: [{ name: 'Terraria' }],
    xboxGames: [],
    epicGames: [],
    resolveEntity: async () => 'NONE'
  });

  await orchestrator.launchGame('some totally unowned title');

  assert.equal(resolveGameCalls[0].options?.skipLlmFallback, true, 'initial existence-check must skip Steam\'s own fallback');
  assert.equal(launchGameCalls[0].options?.skipLlmFallback, true, 'terminal Store-search fallback must also skip Steam\'s own fallback');
});

test('all-three-miss + combined LLM hit on Xbox dispatches to XboxHarness.launchGame with the resolved name', async () => {
  const resolveCalls = [];
  const { orchestrator, calls } = makeOrchestratorWithFallback({
    steamLibraryGames: [{ name: 'Dota 2' }],
    xboxGames: [{ name: 'Hades II' }],
    epicGames: [{ name: 'Fortnite' }],
    resolveEntity: async (args) => { resolveCalls.push(args); return 'Hades II'; }
  });

  const result = await orchestrator.launchGame('hades to', ['hades two']);

  assert.equal(result.success, true);
  assert.equal(result.gameName, 'Hades II');
  assert.equal(result.source, 'xbox');
  assert.ok(calls.includes('xbox.launchGame(Hades II)'), 'should dispatch using the LLM-resolved name, not the original query');
  assert.equal(resolveCalls.length, 1);
  assert.deepEqual(resolveCalls[0].candidates, ['Dota 2', 'Hades II', 'Fortnite']);
  assert.equal(resolveCalls[0].kind, 'game to launch (any platform)');
});

test('all-three-miss + LLM returns NONE still falls through to steamHarness.launchGame', async () => {
  const { orchestrator, calls } = makeOrchestratorWithFallback({
    steamLibraryGames: [{ name: 'Dota 2' }],
    xboxGames: [],
    epicGames: [],
    resolveEntity: async () => 'NONE'
  });

  const result = await orchestrator.launchGame('some totally unowned title');

  assert.equal(result.success, false);
  assert.ok(calls.includes('steam.launchGame(some totally unowned title)'));
});

test('no resolveEntity injected: falls straight through to steamHarness.launchGame without error', async () => {
  const { orchestrator, calls } = makeOrchestratorWithFallback({
    steamLibraryGames: [],
    xboxGames: [],
    epicGames: []
  });

  const result = await orchestrator.launchGame('anything');

  assert.equal(result.success, false);
  assert.ok(calls.includes('steam.launchGame(anything)'));
});
