import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('useGroq false, OpenRouter configured: only OpenRouter is called', async () => {
  const jarvis = createJarvis();
  jarvis.openRouter.apiKey = 'fake-openrouter-key'; // OpenRouter is configured
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return 'should not be used';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.groqCalls.length, 0, 'Groq must not be called when useGroq is off and OpenRouter is configured');
  assert.equal(jarvis.llmCalls.length, 1, 'OpenRouter handled the request');
});

test('useGroq false, OpenRouter NOT configured: Groq is used automatically', async () => {
  const jarvis = createJarvis();
  jarvis.openRouter.apiKey = ''; // OpenRouter has no key — makes it "optional" when Groq exists
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return 'groq answer';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.groqCalls.length, 1, 'Groq is tried automatically since OpenRouter has no key, even with the switch off');
  assert.equal(jarvis.llmCalls.length, 0, 'OpenRouter must not be called when it has no key and Groq already answered');
});

test('useGroq true and Groq succeeds: OpenRouter is never called', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return 'groq answer';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.groqCalls.length, 1);
  assert.equal(jarvis.llmCalls.length, 0, 'OpenRouter must not be called when Groq already answered');
});

test('useGroq true and Groq fails: falls through to OpenRouter', async () => {
  saveSettings({ useGroq: true });
  const jarvis = createJarvis();
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return null; // simulates missing key / rate limit / network error
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.groqCalls.length, 1);
  assert.equal(jarvis.llmCalls.length, 1, 'OpenRouter picks up the request after Groq returns null');
});

test('Ultra tier with a Gemini key: Gemini answers, Groq and OpenRouter are never called', async () => {
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'ultra';
  jarvis.gemini.apiKey = 'fake-gemini-key';
  jarvis.geminiCalls = [];
  jarvis.gemini.chatWithJarvis = async (input) => {
    jarvis.geminiCalls.push(input);
    return 'gemini answer';
  };
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return 'should not be used';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.geminiCalls.length, 1);
  assert.equal(jarvis.groqCalls.length, 0, 'Groq must not be called when Gemini already answered at Ultra tier');
  assert.equal(jarvis.llmCalls.length, 0, 'OpenRouter must not be called when Gemini already answered at Ultra tier');
});

test('Ultra tier with a Gemini key that fails: falls through to the normal Groq/OpenRouter chain', async () => {
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'ultra';
  jarvis.gemini.apiKey = 'fake-gemini-key';
  jarvis.geminiCalls = [];
  jarvis.gemini.chatWithJarvis = async (input) => {
    jarvis.geminiCalls.push(input);
    return null; // simulates missing key / rate limit / network error
  };
  jarvis.openRouter.apiKey = 'fake-openrouter-key';

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.geminiCalls.length, 1);
  assert.equal(jarvis.llmCalls.length, 1, 'OpenRouter picks up the request after Gemini returns null');
});

test('Ultra tier with no Gemini key: skips Gemini entirely and uses the normal Groq/OpenRouter chain', async () => {
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'ultra';
  jarvis.gemini.apiKey = ''; // no Gemini key configured
  jarvis.geminiCalls = [];
  jarvis.gemini.chatWithJarvis = async (input) => {
    jarvis.geminiCalls.push(input);
    return 'should not be called';
  };
  jarvis.openRouter.apiKey = 'fake-openrouter-key';

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.geminiCalls.length, 0, 'Gemini is never attempted without a key');
  assert.equal(jarvis.llmCalls.length, 1, 'OpenRouter handled the request instead');
});
