import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

test('"start monitoring my screen" arms monitoring via ScreenVisionHarness and speaks its message', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.screenVisionHarness.startMonitoring = async () => { calls.push('start'); return { success: true, message: 'Monitoring your screen now, Sir.' }; };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('start monitoring my screen');

  assert.deepEqual(calls, ['start']);
  assert.deepEqual(spoken, ['Monitoring your screen now, Sir.']);
});

test('"stop monitoring my screen" disarms monitoring via ScreenVisionHarness', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.screenVisionHarness.stopMonitoring = async () => { calls.push('stop'); return { success: true, message: 'Stopped monitoring, Sir.' }; };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('stop monitoring my screen');

  assert.deepEqual(calls, ['stop']);
  assert.deepEqual(spoken, ['Stopped monitoring, Sir.']);
});

test('"what\'s on my screen" routes to ScreenVisionHarness.askAboutScreen and speaks its answer', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.screenVisionHarness.askAboutScreen = async (question) => { calls.push(question); return { success: true, message: 'A terminal with a stack trace.' }; };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput("what's on my screen");

  assert.equal(calls.length, 1);
  assert.deepEqual(spoken, ['A terminal with a stack trace.']);
});

test('a screen-vision failure result is still spoken as-is, not treated as a crash', async () => {
  const jarvis = createJarvis();
  jarvis.screenVisionHarness.askAboutScreen = async () => ({ success: false, message: "I wasn't able to capture your screen, Sir." });
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('what is on my screen');

  assert.deepEqual(spoken, ["I wasn't able to capture your screen, Sir."]);
});

test('a non-screen query never calls the ScreenVisionHarness', async () => {
  const jarvis = createJarvis();
  jarvis.screenCalls = [];
  jarvis.screenVisionHarness.askAboutScreen = async () => { jarvis.screenCalls.push('ask'); return { success: true, message: '' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.screenCalls.length, 0);
});

test('an AI SCREEN_QUERY misclassification on a non-screen question is re-routed to web search, not screen vision', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => JSON.stringify({
    shouldCallTool: true,
    toolName: 'SCREEN_QUERY',
    confidence: 0.9,
    params: { question: 'what is the weather in my location' },
    reasoning: 'misclassified'
  });
  jarvis.screenCalls = [];
  jarvis.screenVisionHarness.askAboutScreen = async () => { jarvis.screenCalls.push('ask'); return { success: true, message: 'screen answer' }; };
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input, context, options) => { jarvis.groqCalls.push(options); return 'It is sunny, Sir.'; };
  jarvis.voiceEngine.speak = async () => {};
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.groq.setTier('medium');

  await jarvis.processUserInput('what is the weather in my location');

  assert.equal(jarvis.screenCalls.length, 0);
  assert.equal(jarvis.groqCalls.length, 1);
  assert.equal(jarvis.groqCalls[0].tools, jarvis.groundingTools);
  assert.equal(jarvis.groqCalls[0].toolExecutor, jarvis.toolExecutor);
});

test('a genuinely screen-related question stays on the screen-vision path', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => JSON.stringify({
    shouldCallTool: true,
    toolName: 'SCREEN_QUERY',
    confidence: 0.9,
    params: { question: "what's on my screen" },
    reasoning: 'screen question'
  });
  const calls = [];
  jarvis.screenVisionHarness.askAboutScreen = async (question) => { calls.push(question); return { success: true, message: 'A code editor.' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput("what's on my screen");

  assert.deepEqual(calls, ["what's on my screen"]);
});

test('a screen query whose classifier subject is stripped to a bare word still stays on screen vision when the full input references the screen', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => JSON.stringify({
    shouldCallTool: true,
    toolName: 'SCREEN_QUERY',
    confidence: 0.8,
    params: { question: 'temperature' },
    reasoning: 'screen question'
  });
  const calls = [];
  jarvis.screenVisionHarness.askAboutScreen = async (question) => { calls.push(question); return { success: true, message: 'The screen shows 72 degrees.' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('what is the temperature based on my screen');

  assert.deepEqual(calls, ['what is the temperature based on my screen']);
});

test('a reclassified screen query keeps the FULL input as the web-search query, not the bare classifier subject', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => JSON.stringify({
    shouldCallTool: true,
    toolName: 'SCREEN_QUERY',
    confidence: 0.8,
    params: { question: 'temperature' },
    reasoning: 'misclassified'
  });
  jarvis.searchQueries = [];
  jarvis.harness.executeGoogleSearch = async (query) => { jarvis.searchQueries.push(query); return { summary: '72 degrees and sunny.' }; };
  jarvis.voiceEngine.speak = async () => {};
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.groq.setTier('medium');

  await jarvis.processUserInput('what is the temperature here');

  assert.deepEqual(jarvis.searchQueries, ['what is the temperature here']);
});

test('a temperature question routed to GOOGLE_SEARCH carries a get_weather nudge in the LLM prompt', async () => {
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => JSON.stringify({
    shouldCallTool: true,
    toolName: 'GOOGLE_SEARCH',
    confidence: 0.9,
    params: { query: 'what is the temperature here' },
    reasoning: 'web search'
  });
  jarvis.harness.executeGoogleSearch = async () => ({ summary: 'irrelevant search result.' });
  const prompts = [];
  jarvis._chatWithActiveLLM = async (prompt) => { prompts.push(prompt); return '22 degrees, Sir.'; };
  jarvis.voiceEngine.speak = async () => {};
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.groq.setTier('medium');

  await jarvis.processUserInput('what is the temperature here');

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /get_weather/);
  assert.match(prompts[0], /get_location/);
});
