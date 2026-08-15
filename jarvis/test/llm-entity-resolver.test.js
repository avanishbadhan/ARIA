import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWithLlmFallback } from '../src/llm-entity-resolver.js';

test('returns null immediately when no resolveEntity is injected, without touching candidates', async () => {
  const candidates = [{ name: 'Elden Ring' }];
  const result = await resolveWithLlmFallback({
    query: 'eldn ring',
    candidates,
    kind: 'game',
    resolveEntity: undefined
  });

  assert.equal(result, null);
});

test('returns null immediately when the candidate list is empty, without calling resolveEntity', async () => {
  let called = false;
  const result = await resolveWithLlmFallback({
    query: 'eldn ring',
    candidates: [],
    kind: 'game',
    resolveEntity: async () => { called = true; return 'Elden Ring'; }
  });

  assert.equal(result, null);
  assert.equal(called, false);
});

test('returns the matching candidate object when the LLM picks an exact name', async () => {
  const candidates = [{ name: 'Elden Ring', appid: '1245620' }, { name: 'Dota 2', appid: '570' }];
  const result = await resolveWithLlmFallback({
    query: 'eldn ring',
    candidates,
    kind: 'game',
    resolveEntity: async () => 'Elden Ring'
  });

  assert.deepEqual(result, { name: 'Elden Ring', appid: '1245620' });
});

test('matches case-insensitively and trims whitespace', async () => {
  const candidates = [{ name: 'Elden Ring' }];
  const result = await resolveWithLlmFallback({
    query: 'eldn ring',
    candidates,
    kind: 'game',
    resolveEntity: async () => '  elden ring  '
  });

  assert.deepEqual(result, { name: 'Elden Ring' });
});

test('returns null when the LLM responds with NONE', async () => {
  const candidates = [{ name: 'Elden Ring' }];
  const result = await resolveWithLlmFallback({
    query: 'asdkjaslkdj',
    candidates,
    kind: 'game',
    resolveEntity: async () => 'NONE'
  });

  assert.equal(result, null);
});

test('logs that it is consulting the LLM before calling resolveEntity, and logs when the model finds no match', async () => {
  const candidates = [{ name: 'Elden Ring' }, { name: 'Dota 2' }];
  const logs = [];
  const result = await resolveWithLlmFallback({
    query: 'asdkjaslkdj',
    candidates,
    kind: 'game',
    resolveEntity: async () => 'NONE',
    onLog: (l) => logs.push(l)
  });

  assert.equal(result, null);
  assert.ok(logs.some(l => l.message.includes('asking the LLM to pick from 2 candidate(s)')), 'should log before calling resolveEntity');
  assert.ok(logs.some(l => l.message.includes('no plausible match')), 'should log when the model explicitly finds nothing');
});

test('logs when no LLM provider was available at all (resolveEntity returned a falsy, non-NONE value)', async () => {
  const candidates = [{ name: 'Elden Ring' }];
  const logs = [];
  const result = await resolveWithLlmFallback({
    query: 'eldn ring',
    candidates,
    kind: 'game',
    resolveEntity: async () => null,
    onLog: (l) => logs.push(l)
  });

  assert.equal(result, null);
  assert.ok(logs.some(l => l.message.includes('No LLM provider available')));
});

test('returns null and logs a discard when the LLM invents a title not in the candidate list', async () => {
  const candidates = [{ name: 'Elden Ring' }];
  const logs = [];
  const result = await resolveWithLlmFallback({
    query: 'eldn ring',
    candidates,
    kind: 'game',
    resolveEntity: async () => 'Some Made Up Game',
    onLog: (l) => logs.push(l)
  });

  assert.equal(result, null);
  assert.ok(logs.some(l => l.message.includes('discarding')));
});

test('passes query, alternatives, and candidate names through to resolveEntity', async () => {
  const candidates = [{ name: 'Elden Ring' }, { name: 'Dota 2' }];
  let receivedArgs = null;
  await resolveWithLlmFallback({
    query: 'eldn ring',
    alternatives: ['eldon ring', 'elder ring'],
    candidates,
    kind: 'Steam game to launch',
    resolveEntity: async (args) => { receivedArgs = args; return 'NONE'; }
  });

  assert.deepEqual(receivedArgs, {
    query: 'eldn ring',
    alternatives: ['eldon ring', 'elder ring'],
    candidates: ['Elden Ring', 'Dota 2'],
    kind: 'Steam game to launch'
  });
});

test('returns null when resolveEntity throws (network/API error)', async () => {
  const candidates = [{ name: 'Elden Ring' }];
  const logs = [];
  const result = await resolveWithLlmFallback({
    query: 'eldn ring',
    candidates,
    kind: 'game',
    resolveEntity: async () => { throw new Error('rate limited'); },
    onLog: (l) => logs.push(l)
  });

  assert.equal(result, null);
  assert.ok(logs.some(l => l.message.includes('rate limited')));
});
