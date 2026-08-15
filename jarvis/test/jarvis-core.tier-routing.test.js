/**
 * Tests that a model-tier switch command updates settings and the Groq
 * client's active model without an LLM call, and that it prompts for a key
 * instead of silently no-oping when Groq isn't configured.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { loadSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('switching tiers with a Groq key configured updates settings and the client, and speaks a confirmation', async () => {
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('switch mode to high');

  assert.equal(jarvis.llmCalls.length, 0, 'no LLM call for a tier switch');
  assert.equal(jarvis.groq.currentTier, 'high');
  assert.equal(loadSettings().groqModelTier, 'high');
  assert.equal(loadSettings().useGroq, true, 'switching tiers implies Groq should be the active provider');
  assert.deepEqual(spoken, ['Switched to High mode, Sir.']);
});

test('switching tiers without a Groq key prompts for setup instead of applying anything', async () => {
  const jarvis = createJarvis();
  jarvis.groq.apiKey = ''; // no key configured

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('switch mode to high');

  assert.equal(jarvis.groq.currentTier, 'quick', 'tier is untouched when there is no key');
  assert.equal(loadSettings().groqModelTier, 'quick', 'default settings are untouched');
  assert.deepEqual(spoken, ["You'll need a Groq API key in Settings first, Sir."]);
});
