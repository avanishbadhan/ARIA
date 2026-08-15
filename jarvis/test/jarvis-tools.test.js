import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUNDING_TOOLS, createToolExecutor } from '../src/jarvis-tools.js';

test('GROUNDING_TOOLS only lists read-only tools, no action tools', () => {
  const names = GROUNDING_TOOLS.map(t => t.function.name);
  assert.deepEqual(names, ['solve_math', 'web_search']);
});

test('solve_math delegates to wolfram.solve with the parsed query', async () => {
  const calls = [];
  const wolfram = { solve: async (query) => { calls.push(query); return 'The result is 4.'; } };
  const executor = createToolExecutor({ wolfram, harness: null });

  const result = await executor('solve_math', '{"query":"2+2"}');

  assert.equal(result, 'The result is 4.');
  assert.deepEqual(calls, ['2+2']);
});

test('solve_math returns a graceful fallback string when wolfram has no answer', async () => {
  const wolfram = { solve: async () => null };
  const executor = createToolExecutor({ wolfram, harness: null });

  const result = await executor('solve_math', '{"query":"2+2"}');

  assert.match(result, /unavailable|no result/i);
});

test('solve_math returns a graceful fallback string when wolfram.solve throws', async () => {
  const wolfram = { solve: async () => { throw new Error('network error'); } };
  const executor = createToolExecutor({ wolfram, harness: null });

  const result = await executor('solve_math', '{"query":"2+2"}');

  assert.match(result, /unavailable|no result/i);
});

test('web_search delegates to harness.fetchLiveSearchAnswer with the parsed query', async () => {
  const calls = [];
  const harness = { fetchLiveSearchAnswer: async (query) => { calls.push(query); return 'Paris is the capital of France.'; } };
  const executor = createToolExecutor({ wolfram: null, harness });

  const result = await executor('web_search', '{"query":"capital of France"}');

  assert.equal(result, 'Paris is the capital of France.');
  assert.deepEqual(calls, ['capital of France']);
});

test('web_search replaces the tab-opening fallback sentinel with a neutral no-result string', async () => {
  const harness = { fetchLiveSearchAnswer: async () => 'I have launched a Google search for "xyz". Check your active browser tab and HUD viewport for full details.' };
  const executor = createToolExecutor({ wolfram: null, harness });

  const result = await executor('web_search', '{"query":"xyz"}');

  assert.doesNotMatch(result, /browser tab|HUD viewport/i);
});

test('web_search returns a graceful fallback string when the harness throws', async () => {
  const harness = { fetchLiveSearchAnswer: async () => { throw new Error('network error'); } };
  const executor = createToolExecutor({ wolfram: null, harness });

  const result = await executor('web_search', '{"query":"xyz"}');

  assert.equal(result, 'No web search result found for this query.');
});

test('unknown tool names resolve to a descriptive string instead of throwing', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  const result = await executor('launch_missiles', '{}');

  assert.match(result, /unknown tool/i);
});

test('unparseable arguments resolve to a descriptive string instead of throwing', async () => {
  const executor = createToolExecutor({ wolfram: { solve: async () => 'x' }, harness: null });

  const result = await executor('solve_math', 'not json');

  assert.match(result, /invalid/i);
});
