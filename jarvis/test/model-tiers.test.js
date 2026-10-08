import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_TIERS, TIER_ORDER, normalizeTierAlias, getModelQueue } from '../src/model-tiers.js';

test('MODEL_TIERS has all four tiers with a model id, provider, and label', () => {
  for (const key of ['quick', 'medium', 'high', 'ultra']) {
    assert.ok(MODEL_TIERS[key].model, `${key} has a model id`);
    assert.ok(MODEL_TIERS[key].provider, `${key} has a provider`);
    assert.ok(MODEL_TIERS[key].label, `${key} has a label`);
  }
});

test('Quick/Medium/High run on Groq; Ultra runs on Gemini', () => {
  assert.equal(MODEL_TIERS.quick.provider, 'groq');
  assert.equal(MODEL_TIERS.medium.provider, 'groq');
  assert.equal(MODEL_TIERS.high.provider, 'groq');
  assert.equal(MODEL_TIERS.ultra.provider, 'gemini');
});

test('each Groq tier leads with its own model and falls back to the other two', () => {
  assert.deepEqual(getModelQueue('quick'), ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b']);
  assert.deepEqual(getModelQueue('medium'), ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
  assert.deepEqual(getModelQueue('high'), ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']);
});

test('no Groq tier references a model Groq has decommissioned', () => {
  // Groq's API returned "does not exist" for these as of 2026-10.
  const retired = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'qwen/qwen3.6-27b'];
  for (const tier of ['quick', 'medium', 'high']) {
    for (const model of getModelQueue(tier)) assert.ok(!retired.includes(model), `${tier} uses retired ${model}`);
  }
});

test('getModelQueue("ultra") tries the newest Gemini model first, then falls back through older generations', () => {
  assert.deepEqual(getModelQueue('ultra'), [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro'
  ]);
});

test('getModelQueue returns an empty array for an unknown tier', () => {
  assert.deepEqual(getModelQueue('nonexistent'), []);
});

test('TIER_ORDER lists all four tiers in ascending order', () => {
  assert.deepEqual(TIER_ORDER, ['quick', 'medium', 'high', 'ultra']);
});

const aliasCases = [
  ['quick', 'quick'], ['low', 'quick'], ['fast', 'quick'],
  ['medium', 'medium'], ['mid', 'medium'],
  ['high', 'high'],
  ['ultra', 'ultra'], ['max', 'ultra'], ['maximum', 'ultra'],
  ['QUICK', 'quick'], ['High', 'high']
];

for (const [word, expected] of aliasCases) {
  test(`normalizeTierAlias("${word}") -> "${expected}"`, () => {
    assert.equal(normalizeTierAlias(word), expected);
  });
}

test('normalizeTierAlias returns null for unrecognized words', () => {
  assert.equal(normalizeTierAlias('insane'), null);
  assert.equal(normalizeTierAlias(''), null);
  assert.equal(normalizeTierAlias(null), null);
});
