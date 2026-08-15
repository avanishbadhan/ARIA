import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('_askVisionLLM prefers Groq when useGroq is on and it succeeds', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.openRouter.apiKey = 'fake-openrouter-key';
  const groqCalls = [];
  jarvis.groq.generateVisionCompletion = async (messages, options) => { groqCalls.push({ messages, options }); return 'A terminal window.'; };
  jarvis.openRouter.generateVisionCompletion = async () => { throw new Error('should not be called'); };

  const result = await jarvis._askVisionLLM({ question: 'what is this?', imageDataUrl: 'data:image/jpeg;base64,FAKE' });

  assert.equal(result, 'A terminal window.');
  assert.equal(groqCalls.length, 1);
  const userMessage = groqCalls[0].messages.find(m => m.role === 'user');
  assert.ok(Array.isArray(userMessage.content));
  assert.ok(userMessage.content.some(c => c.type === 'text' && c.text === 'what is this?'));
  assert.ok(userMessage.content.some(c => c.type === 'image_url' && c.image_url.url === 'data:image/jpeg;base64,FAKE'));
});

test('_askVisionLLM falls through to OpenRouter when Groq returns nothing', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.openRouter.apiKey = 'fake-openrouter-key';
  jarvis.groq.generateVisionCompletion = async () => { throw new Error('rate limited'); };
  const openRouterCalls = [];
  jarvis.openRouter.generateVisionCompletion = async () => { openRouterCalls.push(1); return 'A terminal window.'; };

  const result = await jarvis._askVisionLLM({ question: 'what is this?', imageDataUrl: 'data:image/jpeg;base64,FAKE' });

  assert.equal(result, 'A terminal window.');
  assert.equal(openRouterCalls.length, 1);
});

test('_askVisionLLM returns null when neither provider has a key configured', async () => {
  const jarvis = createJarvis();
  jarvis.groq.apiKey = '';
  jarvis.openRouter.apiKey = '';

  const result = await jarvis._askVisionLLM({ question: 'what is this?', imageDataUrl: 'data:image/jpeg;base64,FAKE' });

  assert.equal(result, null);
});

test('JarvisCore constructor wires screenVisionHarness.askVisionLLM to _askVisionLLM', async () => {
  const jarvis = createJarvis();
  jarvis._askVisionLLM = async () => 'wired-answer';

  const answer = await jarvis.screenVisionHarness.askVisionLLM({ question: 'x', imageDataUrl: 'y' });

  assert.equal(answer, 'wired-answer');
});
