import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('_classifyIntentWithAI prefers Groq when useGroq is on and it succeeds', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  delete jarvis._classifyIntentWithAI; // restore the real method for this test
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.openRouter.apiKey = 'fake-openrouter-key';
  const groqCalls = [];
  jarvis.groq.generateCompletion = async (messages, options) => { groqCalls.push({ messages, options }); return '{"toolName":"CONVERSATIONAL","params":{}}'; };
  jarvis.openRouter.generateCompletion = async () => { throw new Error('should not be called'); };

  const result = await jarvis._classifyIntentWithAI('how are you');

  assert.equal(result, '{"toolName":"CONVERSATIONAL","params":{}}');
  assert.equal(groqCalls.length, 1);
  assert.equal(groqCalls[0].options.temperature, 0.1);
  assert.equal(groqCalls[0].options.maxTokens, 200);
  const systemMessage = groqCalls[0].messages.find(m => m.role === 'system');
  assert.match(systemMessage.content, /STEAM_LAUNCH_GAME/);
  const userMessage = groqCalls[0].messages.find(m => m.role === 'user');
  assert.equal(userMessage.content, 'how are you');
});

test('_classifyIntentWithAI falls through to OpenRouter when Groq returns nothing', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  delete jarvis._classifyIntentWithAI;
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.openRouter.apiKey = 'fake-openrouter-key';
  jarvis.groq.generateCompletion = async () => { throw new Error('rate limited'); };
  const openRouterCalls = [];
  jarvis.openRouter.generateCompletion = async (messages, options) => { openRouterCalls.push({ messages, options }); return '{"toolName":"CONVERSATIONAL","params":{}}'; };

  const result = await jarvis._classifyIntentWithAI('how are you');

  assert.equal(result, '{"toolName":"CONVERSATIONAL","params":{}}');
  assert.equal(openRouterCalls.length, 1);
});

test('_classifyIntentWithAI returns null when neither provider has a key configured', async () => {
  const jarvis = createJarvis();
  delete jarvis._classifyIntentWithAI;
  jarvis.groq.apiKey = '';
  jarvis.openRouter.apiKey = '';

  const result = await jarvis._classifyIntentWithAI('how are you');

  assert.equal(result, null);
});
