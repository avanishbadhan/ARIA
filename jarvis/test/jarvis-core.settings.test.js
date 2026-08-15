import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('Google search branch opens a tab when openTabOnSearch is true (default)', async () => {
  const calls = [];
  const jarvis = createJarvis({
    executeGoogleSearch: async (query, openTab) => {
      calls.push({ query, openTab });
      return { summary: 'mock summary' };
    }
  });

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].openTab, true);
});

test('Google search branch respects openTabOnSearch = false from settings', async () => {
  saveSettings({ openTabOnSearch: false });
  const calls = [];
  const jarvis = createJarvis({
    executeGoogleSearch: async (query, openTab) => {
      calls.push({ query, openTab });
      return { summary: 'mock summary' };
    }
  });

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].openTab, false);
});
