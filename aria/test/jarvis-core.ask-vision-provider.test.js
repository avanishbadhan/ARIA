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

test('_askVisionLLM describes the image as a webcam frame when source is "camera"', async () => {
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';
  const groqCalls = [];
  jarvis.groq.generateVisionCompletion = async (messages) => { groqCalls.push(messages); return 'Three fingers.'; };

  await jarvis._askVisionLLM({ question: 'how many fingers?', imageDataUrl: 'data:image/jpeg;base64,FAKE', source: 'camera' });

  const systemMessage = groqCalls[0].find(m => m.role === 'system');
  assert.match(systemMessage.content, /webcam/);
  assert.doesNotMatch(systemMessage.content, /screenshot/);
});

test('_askVisionLLM defaults to describing a screenshot when source is omitted', async () => {
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';
  const groqCalls = [];
  jarvis.groq.generateVisionCompletion = async (messages) => { groqCalls.push(messages); return 'A terminal.'; };

  await jarvis._askVisionLLM({ question: 'what is this?', imageDataUrl: 'data:image/jpeg;base64,FAKE' });

  const systemMessage = groqCalls[0].find(m => m.role === 'system');
  assert.match(systemMessage.content, /screenshot/);
});

test('_askVisionLLM routes to Gemini first when on Ultra tier with a Gemini key, and Groq/OpenRouter are never called', async () => {
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'ultra';
  jarvis.gemini.apiKey = 'fake-gemini-key';
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.openRouter.apiKey = 'fake-openrouter-key';
  const geminiCalls = [];
  jarvis.gemini.generateVisionCompletion = async (messages) => { geminiCalls.push(messages); return 'Three fingers.'; };
  jarvis.groq.generateVisionCompletion = async () => { throw new Error('should not be called'); };
  jarvis.openRouter.generateVisionCompletion = async () => { throw new Error('should not be called'); };

  const result = await jarvis._askVisionLLM({ question: 'how many fingers?', imageDataUrl: 'data:image/jpeg;base64,FAKE', source: 'camera' });

  assert.equal(result, 'Three fingers.');
  assert.equal(geminiCalls.length, 1);
});

test('_askVisionLLM falls through to Groq/OpenRouter when Gemini fails at Ultra tier', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'ultra';
  jarvis.gemini.apiKey = 'fake-gemini-key';
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.gemini.generateVisionCompletion = async () => { throw new Error('rate limited'); };
  const groqCalls = [];
  jarvis.groq.generateVisionCompletion = async () => { groqCalls.push(1); return 'A terminal window.'; };

  const result = await jarvis._askVisionLLM({ question: 'what is this?', imageDataUrl: 'data:image/jpeg;base64,FAKE' });

  assert.equal(result, 'A terminal window.');
  assert.equal(groqCalls.length, 1);
});

test('_askVisionLLM does not attempt Gemini when not on Ultra tier, even with a Gemini key configured', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'high';
  jarvis.gemini.apiKey = 'fake-gemini-key';
  jarvis.groq.apiKey = 'fake-groq-key';
  const geminiCalls = [];
  jarvis.gemini.generateVisionCompletion = async () => { geminiCalls.push(1); return 'should not be used'; };
  jarvis.groq.generateVisionCompletion = async () => 'A terminal window.';

  const result = await jarvis._askVisionLLM({ question: 'what is this?', imageDataUrl: 'data:image/jpeg;base64,FAKE' });

  assert.equal(result, 'A terminal window.');
  assert.equal(geminiCalls.length, 0);
});

test('JarvisCore constructor wires cameraVisionHarness.askVisionLLM to _askVisionLLM, when a CameraVisionHarness was injected', async () => {
  const { JarvisCore } = await import('../src/jarvis-core.js');
  const voiceEngine = { playBeep: () => {}, playSearchLaunchSound: () => {}, speak: async () => {} };
  const harness = { executeGoogleSearch: async () => ({}), openWebsite: () => ({}) };
  const cameraVisionHarness = {};

  const jarvis = new JarvisCore(voiceEngine, harness, { cameraVisionHarness });
  jarvis._askVisionLLM = async () => 'wired-answer';

  const answer = await cameraVisionHarness.askVisionLLM({ question: 'x', imageDataUrl: 'y' });

  assert.equal(answer, 'wired-answer');
});
