/**
 * Tests Hermes's place in the provider fallback chain: tried first when
 * useHermes is on and a key is configured (ahead of Groq/OpenRouter, since
 * it's the more capable/agentic model for tool-calling), behind Gemini at
 * Ultra tier, falling through to Groq/OpenRouter on failure or no key —
 * mirrors jarvis-core.llm-provider.test.js's Groq/OpenRouter tests.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('useHermes false: Hermes is never called', async () => {
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = 'fake-openrouter-key';
  jarvis.hermesCalls = [];
  jarvis.hermes.chatWithJarvis = async (input) => {
    jarvis.hermesCalls.push(input);
    return 'should not be used';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.hermesCalls.length, 0, 'Hermes must not be called when useHermes is off');
  assert.equal(jarvis.llmCalls.length, 1, 'OpenRouter handled the request');
});

test('useHermes true and Hermes succeeds: Groq and OpenRouter are never called', async () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = 'fake-openrouter-key';
  jarvis.hermesCalls = [];
  jarvis.hermes.chatWithJarvis = async (input) => {
    jarvis.hermesCalls.push(input);
    return 'hermes answer';
  };
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return 'should not be used';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.hermesCalls.length, 1);
  assert.equal(jarvis.groqCalls.length, 0, 'Groq must not be called when Hermes already answered');
  assert.equal(jarvis.llmCalls.length, 0, 'OpenRouter must not be called when Hermes already answered');
});

test('useHermes true and Hermes fails: falls through to the normal Groq/OpenRouter chain', async () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = 'fake-openrouter-key';
  jarvis.hermesCalls = [];
  jarvis.hermes.chatWithJarvis = async (input) => {
    jarvis.hermesCalls.push(input);
    return null; // simulates missing key / rate limit / network error
  };
  jarvis.openRouter.apiKey = 'fake-openrouter-key';

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.hermesCalls.length, 1);
  assert.equal(jarvis.llmCalls.length, 1, 'OpenRouter picks up the request after Hermes returns null');
});

test('useHermes true but no OpenRouter key configured: Hermes is skipped entirely', async () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.hermes.apiKey = ''; // no OpenRouter key configured, so Hermes has none either
  jarvis.hermesCalls = [];
  jarvis.hermes.chatWithJarvis = async (input) => {
    jarvis.hermesCalls.push(input);
    return 'should not be called';
  };
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input) => {
    jarvis.groqCalls.push(input);
    return 'groq answer';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.hermesCalls.length, 0, 'Hermes is never attempted without a key');
  assert.equal(jarvis.groqCalls.length, 1, 'falls through to Groq instead');
});

test('Ultra tier with a Gemini key takes priority over Hermes', async () => {
  saveSettings({ useHermes: true });
  const jarvis = createJarvis();
  jarvis.groq.currentTier = 'ultra';
  jarvis.gemini.apiKey = 'fake-gemini-key';
  jarvis.geminiCalls = [];
  jarvis.gemini.chatWithJarvis = async (input) => {
    jarvis.geminiCalls.push(input);
    return 'gemini answer';
  };
  jarvis.hermes.apiKey = 'fake-openrouter-key';
  jarvis.hermesCalls = [];
  jarvis.hermes.chatWithJarvis = async (input) => {
    jarvis.hermesCalls.push(input);
    return 'should not be used';
  };

  await jarvis.processUserInput('What is the capital of Japan?');

  assert.equal(jarvis.geminiCalls.length, 1);
  assert.equal(jarvis.hermesCalls.length, 0, 'Hermes must not be called when Gemini already answered at Ultra tier');
});
