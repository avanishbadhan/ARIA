import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntentWithAI } from '../src/ai-intent-classifier.js';

test('returns null when no classifyIntent function is provided', async () => {
  const result = await classifyIntentWithAI({ input: 'open spotify' });
  assert.equal(result, null);
});

test('returns null when classifyIntent throws', async () => {
  const logs = [];
  const result = await classifyIntentWithAI({
    input: 'open spotify',
    classifyIntent: async () => { throw new Error('network error'); },
    onLog: (l) => logs.push(l)
  });
  assert.equal(result, null);
  assert.ok(logs.some(l => l.type === 'WARNING'));
});

test('returns null when classifyIntent returns null (no provider configured)', async () => {
  const result = await classifyIntentWithAI({ input: 'open spotify', classifyIntent: async () => null });
  assert.equal(result, null);
});

test('returns null when the response is not valid JSON', async () => {
  const logs = [];
  const result = await classifyIntentWithAI({
    input: 'open spotify',
    classifyIntent: async () => 'sure, opening spotify for you!',
    onLog: (l) => logs.push(l)
  });
  assert.equal(result, null);
  assert.ok(logs.some(l => l.type === 'WARNING'));
});

test('strips a markdown code fence before parsing JSON', async () => {
  const result = await classifyIntentWithAI({
    input: 'open spotify',
    classifyIntent: async () => '```json\n{"shouldCallTool":true,"toolName":"SPOTIFY_OPEN_CLIENT","confidence":0.9,"params":{},"reasoning":"x"}\n```'
  });
  assert.equal(result.toolName, 'SPOTIFY_OPEN_CLIENT');
});

test('returns null for an unrecognized toolName', async () => {
  const result = await classifyIntentWithAI({
    input: 'open spotify',
    classifyIntent: async () => JSON.stringify({ shouldCallTool: true, toolName: 'MADE_UP_TOOL', confidence: 0.9, params: {}, reasoning: 'x' })
  });
  assert.equal(result, null);
});

test('returns null when a required param is missing', async () => {
  const result = await classifyIntentWithAI({
    input: 'launch elden ring',
    classifyIntent: async () => JSON.stringify({ shouldCallTool: true, toolName: 'STEAM_LAUNCH_GAME', confidence: 0.9, params: {}, reasoning: 'x' })
  });
  assert.equal(result, null);
});

test('accepts a valid decision and clamps confidence into [0,1]', async () => {
  const result = await classifyIntentWithAI({
    input: 'launch elden ring',
    classifyIntent: async () => JSON.stringify({ shouldCallTool: true, toolName: 'STEAM_LAUNCH_GAME', confidence: 1.4, params: { gameQuery: 'Elden Ring' }, reasoning: 'x' })
  });
  assert.equal(result.toolName, 'STEAM_LAUNCH_GAME');
  assert.deepEqual(result.params, { gameQuery: 'Elden Ring' });
  assert.equal(result.confidence, 1);
});

test('defaults confidence and reasoning when the model omits them', async () => {
  const result = await classifyIntentWithAI({
    input: 'open spotify',
    classifyIntent: async () => JSON.stringify({ toolName: 'SPOTIFY_OPEN_CLIENT', params: {} })
  });
  assert.equal(result.toolName, 'SPOTIFY_OPEN_CLIENT');
  assert.equal(typeof result.confidence, 'number');
  assert.equal(typeof result.reasoning, 'string');
});

test('a CONVERSATIONAL decision has shouldCallTool false', async () => {
  const result = await classifyIntentWithAI({
    input: 'how are you',
    classifyIntent: async () => JSON.stringify({ toolName: 'CONVERSATIONAL', params: {} })
  });
  assert.equal(result.shouldCallTool, false);
});

test('a tool decision has shouldCallTool true regardless of what the model sent', async () => {
  const result = await classifyIntentWithAI({
    input: 'open spotify',
    classifyIntent: async () => JSON.stringify({ shouldCallTool: false, toolName: 'SPOTIFY_OPEN_CLIENT', params: {} })
  });
  assert.equal(result.shouldCallTool, true);
});

test('allows a params object with extra unexpected keys through unchanged', async () => {
  const result = await classifyIntentWithAI({
    input: 'launch elden ring',
    classifyIntent: async () => JSON.stringify({ toolName: 'STEAM_LAUNCH_GAME', params: { gameQuery: 'Elden Ring', extra: 'ignored-but-fine' } })
  });
  assert.deepEqual(result.params, { gameQuery: 'Elden Ring', extra: 'ignored-but-fine' });
});

test('accepts a GMAIL_CHECK_INBOX decision', async () => {
  const result = await classifyIntentWithAI({
    input: 'check my email',
    classifyIntent: async () => JSON.stringify({ toolName: 'GMAIL_CHECK_INBOX', params: {} })
  });
  assert.equal(result.toolName, 'GMAIL_CHECK_INBOX');
});

test('accepts a GMAIL_SEARCH decision with its required query param', async () => {
  const result = await classifyIntentWithAI({
    input: 'search my email for the invoice',
    classifyIntent: async () => JSON.stringify({ toolName: 'GMAIL_SEARCH', params: { query: 'the invoice' } })
  });
  assert.equal(result.toolName, 'GMAIL_SEARCH');
  assert.deepEqual(result.params, { query: 'the invoice' });
});

test('rejects a GMAIL_SEARCH decision missing the required query param', async () => {
  const result = await classifyIntentWithAI({
    input: 'search my email',
    classifyIntent: async () => JSON.stringify({ toolName: 'GMAIL_SEARCH', params: {} })
  });
  assert.equal(result, null);
});

test('accepts a GMAIL_READ_MESSAGE decision with its required query param', async () => {
  const result = await classifyIntentWithAI({
    input: 'read me the email from sarah',
    classifyIntent: async () => JSON.stringify({ toolName: 'GMAIL_READ_MESSAGE', params: { query: 'sarah' } })
  });
  assert.equal(result.toolName, 'GMAIL_READ_MESSAGE');
  assert.deepEqual(result.params, { query: 'sarah' });
});

test('accepts a CAMERA_START decision', async () => {
  const result = await classifyIntentWithAI({
    input: 'open camera',
    classifyIntent: async () => JSON.stringify({ toolName: 'CAMERA_START', params: {} })
  });
  assert.equal(result.toolName, 'CAMERA_START');
});

test('accepts a CAMERA_STOP decision', async () => {
  const result = await classifyIntentWithAI({
    input: 'close camera',
    classifyIntent: async () => JSON.stringify({ toolName: 'CAMERA_STOP', params: {} })
  });
  assert.equal(result.toolName, 'CAMERA_STOP');
});

test('accepts a CAMERA_QUERY decision with its required question param', async () => {
  const result = await classifyIntentWithAI({
    input: 'how many fingers am I holding up',
    classifyIntent: async () => JSON.stringify({ toolName: 'CAMERA_QUERY', params: { question: 'how many fingers am I holding up' } })
  });
  assert.equal(result.toolName, 'CAMERA_QUERY');
  assert.deepEqual(result.params, { question: 'how many fingers am I holding up' });
});

test('rejects a CAMERA_QUERY decision missing the required question param', async () => {
  const result = await classifyIntentWithAI({
    input: 'what am I holding',
    classifyIntent: async () => JSON.stringify({ toolName: 'CAMERA_QUERY', params: {} })
  });
  assert.equal(result, null);
});

test('accepts a CALENDAR_LIST_UPCOMING decision', async () => {
  const result = await classifyIntentWithAI({
    input: "what's on my calendar",
    classifyIntent: async () => JSON.stringify({ toolName: 'CALENDAR_LIST_UPCOMING', params: {} })
  });
  assert.equal(result.toolName, 'CALENDAR_LIST_UPCOMING');
});

test('accepts a CALENDAR_SEARCH decision with its required query param', async () => {
  const result = await classifyIntentWithAI({
    input: 'search my calendar for the meeting about budget',
    classifyIntent: async () => JSON.stringify({ toolName: 'CALENDAR_SEARCH', params: { query: 'budget' } })
  });
  assert.equal(result.toolName, 'CALENDAR_SEARCH');
  assert.deepEqual(result.params, { query: 'budget' });
});

test('rejects a CALENDAR_SEARCH decision missing the required query param', async () => {
  const result = await classifyIntentWithAI({
    input: 'search my calendar',
    classifyIntent: async () => JSON.stringify({ toolName: 'CALENDAR_SEARCH', params: {} })
  });
  assert.equal(result, null);
});

test('accepts a CALENDAR_CREATE_EVENT decision with title and when params', async () => {
  const result = await classifyIntentWithAI({
    input: 'schedule a meeting called standup for tomorrow at 9am',
    classifyIntent: async () => JSON.stringify({ toolName: 'CALENDAR_CREATE_EVENT', params: { title: 'standup', when: 'tomorrow at 9am' } })
  });
  assert.equal(result.toolName, 'CALENDAR_CREATE_EVENT');
  assert.deepEqual(result.params, { title: 'standup', when: 'tomorrow at 9am' });
});

test('rejects a CALENDAR_CREATE_EVENT decision missing the when param', async () => {
  const result = await classifyIntentWithAI({
    input: 'schedule a meeting called standup',
    classifyIntent: async () => JSON.stringify({ toolName: 'CALENDAR_CREATE_EVENT', params: { title: 'standup' } })
  });
  assert.equal(result, null);
});

test('rejects a CALENDAR_CREATE_EVENT decision missing the title param', async () => {
  const result = await classifyIntentWithAI({
    input: 'schedule a meeting for tomorrow',
    classifyIntent: async () => JSON.stringify({ toolName: 'CALENDAR_CREATE_EVENT', params: { when: 'tomorrow' } })
  });
  assert.equal(result, null);
});

test('returns null when a required param is null instead of trusting it', async () => {
  const logs = [];
  const result = await classifyIntentWithAI({
    input: 'search my email for the invoice',
    classifyIntent: async () => JSON.stringify({ shouldCallTool: true, toolName: 'GMAIL_SEARCH', confidence: 0.9, params: { query: null }, reasoning: 'x' }),
    onLog: (l) => logs.push(l)
  });
  assert.equal(result, null);
  assert.ok(logs.some(l => l.type === 'WARNING'));
});

test('returns null when a required param is an empty or whitespace-only string', async () => {
  for (const tier of ['', '   ']) {
    const result = await classifyIntentWithAI({
      input: 'switch mode to high',
      classifyIntent: async () => JSON.stringify({ shouldCallTool: true, toolName: 'SET_MODEL_TIER', confidence: 0.9, params: { tier }, reasoning: 'x' })
    });
    assert.equal(result, null, `"${tier}" must not pass as a SET_MODEL_TIER tier`);
  }
});

test('returns null when a required param is not a string', async () => {
  const result = await classifyIntentWithAI({
    input: 'launch elden ring',
    classifyIntent: async () => JSON.stringify({ shouldCallTool: true, toolName: 'STEAM_LAUNCH_GAME', confidence: 0.9, params: { gameQuery: 12345 }, reasoning: 'x' })
  });
  assert.equal(result, null);
});

test('accepts a SET_MODEL_TIER decision with a real tier value', async () => {
  const result = await classifyIntentWithAI({
    input: 'switch mode to high',
    classifyIntent: async () => JSON.stringify({ shouldCallTool: true, toolName: 'SET_MODEL_TIER', confidence: 0.9, params: { tier: 'high' }, reasoning: 'x' })
  });
  assert.equal(result.toolName, 'SET_MODEL_TIER');
  assert.deepEqual(result.params, { tier: 'high' });
});
