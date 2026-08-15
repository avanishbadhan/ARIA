/**
 * Tests that read-only grounding tools (WolframAlpha, web search — see
 * src/jarvis-tools.js) are wired into screen vision and general chat, and
 * deliberately NOT wired into the MATH_QUERY/GOOGLE_SEARCH paths that already
 * have their own dedicated grounding logic.
 * See docs/superpowers/specs/2026-08-14-grounding-tool-calling-design.md.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('_askVisionLLM passes the grounding tools and executor to the vision LLM', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';
  const groqCalls = [];
  jarvis.groq.generateVisionCompletion = async (messages, options) => { groqCalls.push(options); return 'A math problem: 2 + 2.'; };

  await jarvis._askVisionLLM({ question: 'what is this?', imageDataUrl: 'data:image/jpeg;base64,FAKE' });

  assert.equal(groqCalls.length, 1);
  assert.equal(groqCalls[0].tools, jarvis.groundingTools);
  assert.equal(groqCalls[0].toolExecutor, jarvis.toolExecutor);
});

test('general conversational answers (no specific tool matched) get the grounding tools', async () => {
  const jarvis = createJarvis();
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input, context, options) => { jarvis.groqCalls.push(options); return 'answer'; };
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';

  await jarvis.processUserInput('Question number 1'); // matches no MATH_QUERY/GOOGLE_SEARCH regex

  assert.equal(jarvis.groqCalls.length, 1);
  assert.equal(jarvis.groqCalls[0].tools, jarvis.groundingTools);
  assert.equal(jarvis.groqCalls[0].toolExecutor, jarvis.toolExecutor);
});

test('MATH_QUERY LLM fallback (WolframAlpha already returned nothing) does not get the grounding tools', async () => {
  const jarvis = createJarvis();
  jarvis.wolfram.solve = async () => null;
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input, context, options) => { jarvis.groqCalls.push(options); return 'answer'; };
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';

  await jarvis.processUserInput('what is 5 plus 3');

  assert.equal(jarvis.groqCalls.length, 1);
  assert.equal(jarvis.groqCalls[0].tools, undefined);
});

test('GOOGLE_SEARCH grounded-prompt path does not get the grounding tools', async () => {
  const jarvis = createJarvis({
    executeGoogleSearch: async () => ({ summary: 'Paris is the capital of France.' })
  });
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input, context, options) => { jarvis.groqCalls.push(options); return 'answer'; };
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(jarvis.groqCalls.length, 1);
  assert.equal(jarvis.groqCalls[0].tools, undefined);
});

test('GOOGLE_SEARCH "answer from own knowledge" path (High/Ultra tier) does not get the grounding tools', async () => {
  const jarvis = createJarvis();
  jarvis.groq.setTier('high');
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input, context, options) => { jarvis.groqCalls.push(options); return 'answer'; };

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(jarvis.groqCalls.length, 1);
  assert.equal(jarvis.groqCalls[0].tools, undefined);
});
