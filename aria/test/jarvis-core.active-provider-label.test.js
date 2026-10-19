/**
 * _activeProviderLabel names whichever provider is actually about to handle
 * a request, so status/log messages don't hardcode "OpenRouter" regardless
 * of what's really configured (see processUserInput's onStatusChange call
 * and the "Querying ... LLM API" agent-state update).
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('reports Gemini when on Ultra tier with a Gemini key', () => {
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'ultra';
  jarvis.gemini.apiKey = 'fake-gemini-key';

  assert.equal(jarvis._activeProviderLabel(), 'Gemini');
});

test('falls through to Groq/OpenRouter labeling on Ultra tier without a Gemini key', () => {
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'ultra';
  jarvis.gemini.apiKey = '';
  jarvis.groq.apiKey = 'fake-groq-key';
  saveSettings({ useGroq: true });

  assert.equal(jarvis._activeProviderLabel(), 'Groq');
});

test('reports Groq when useGroq is on and a Groq key is configured', () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';

  assert.equal(jarvis._activeProviderLabel(), 'Groq');
});

test('reports Groq automatically when OpenRouter has no key, even with useGroq off', () => {
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.openRouter.apiKey = '';

  assert.equal(jarvis._activeProviderLabel(), 'Groq');
});

test('reports OpenRouter when it is the preferred provider and has a key', () => {
  const jarvis = createJarvis();
  jarvis.openRouter.apiKey = 'fake-openrouter-key';
  jarvis.groq.apiKey = '';

  assert.equal(jarvis._activeProviderLabel(), 'OpenRouter');
});

test('reports the local knowledge base when no provider has a key', () => {
  const jarvis = createJarvis();
  jarvis.groq.apiKey = '';
  jarvis.openRouter.apiKey = '';
  jarvis.gemini.apiKey = '';

  assert.equal(jarvis._activeProviderLabel(), 'local knowledge base');
});

test('processUserInput reports the real active provider in its initial status message, not a hardcoded one', async () => {
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'ultra';
  jarvis.gemini.apiKey = 'fake-gemini-key';
  jarvis.openRouter.apiKey = 'fake-openrouter-key'; // configured but should NOT be the reported provider
  jarvis.gemini.chatWithJarvis = async () => 'answer';

  const statusMessages = [];
  jarvis.onStatusChange = (state) => statusMessages.push(state.message);

  await jarvis.processUserInput('hello');

  assert.ok(statusMessages.some(m => m.includes('Gemini')), `expected a status message mentioning Gemini, got: ${JSON.stringify(statusMessages)}`);
  assert.ok(!statusMessages.some(m => m.includes('OpenRouter')), `status should not claim OpenRouter when Gemini is active, got: ${JSON.stringify(statusMessages)}`);
});

test('reports Hermes when useHermes is on and a key is configured', () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = 'fake-openrouter-key';

  assert.equal(jarvis._activeProviderLabel(), 'Hermes');
});

test('does not report Hermes when useHermes is on but no key is configured', () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = '';
  jarvis.groq.apiKey = 'fake-groq-key';

  assert.equal(jarvis._activeProviderLabel(), 'Groq');
});
