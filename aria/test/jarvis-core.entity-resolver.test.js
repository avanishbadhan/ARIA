import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('_resolveEntityWithLLM prefers Groq when useGroq is on and it succeeds', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.openRouter.apiKey = 'fake-openrouter-key';
  const groqCalls = [];
  jarvis.groq.generateCompletion = async (messages, options) => { groqCalls.push({ messages, options }); return 'Elden Ring'; };
  jarvis.openRouter.generateCompletion = async () => { throw new Error('should not be called'); };

  const result = await jarvis._resolveEntityWithLLM({
    query: 'eldn ring', alternatives: [], candidates: ['Elden Ring', 'Dota 2'], kind: 'Steam game to launch'
  });

  assert.equal(result, 'Elden Ring');
  assert.equal(groqCalls.length, 1);
  assert.equal(groqCalls[0].options.temperature, 0.1);
  assert.equal(groqCalls[0].options.maxTokens, 30);
  const userMessage = groqCalls[0].messages.find(m => m.role === 'user');
  assert.match(userMessage.content, /eldn ring/);
  assert.match(userMessage.content, /Elden Ring/);
  assert.match(userMessage.content, /Steam game to launch/);
});

test('_resolveEntityWithLLM falls through to OpenRouter when Groq returns nothing', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.openRouter.apiKey = 'fake-openrouter-key';
  jarvis.groq.generateCompletion = async () => { throw new Error('rate limited'); };
  const openRouterCalls = [];
  jarvis.openRouter.generateCompletion = async (messages, options) => { openRouterCalls.push({ messages, options }); return 'Elden Ring'; };

  const result = await jarvis._resolveEntityWithLLM({
    query: 'eldn ring', alternatives: ['eldon ring'], candidates: ['Elden Ring'], kind: 'game'
  });

  assert.equal(result, 'Elden Ring');
  assert.equal(openRouterCalls.length, 1);
});

test('_resolveEntityWithLLM prefers OpenRouter when useGroq is off and it is configured', async () => {
  saveSettings({ useGroq: false });
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.openRouter.apiKey = 'fake-openrouter-key';
  jarvis.groq.generateCompletion = async () => { throw new Error('should not be called'); };
  const openRouterCalls = [];
  jarvis.openRouter.generateCompletion = async () => { openRouterCalls.push(1); return 'Elden Ring'; };

  const result = await jarvis._resolveEntityWithLLM({
    query: 'eldn ring', alternatives: [], candidates: ['Elden Ring'], kind: 'game'
  });

  assert.equal(result, 'Elden Ring');
  assert.equal(openRouterCalls.length, 1);
});

test('_resolveEntityWithLLM returns null when neither provider has a key configured', async () => {
  const jarvis = createJarvis();
  jarvis.groq.apiKey = '';
  jarvis.openRouter.apiKey = '';

  const result = await jarvis._resolveEntityWithLLM({
    query: 'eldn ring', alternatives: [], candidates: ['Elden Ring'], kind: 'game'
  });

  assert.equal(result, null);
});
