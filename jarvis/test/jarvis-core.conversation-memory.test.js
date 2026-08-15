/**
 * Tests for JarvisCore's short-term conversation memory (src/jarvis-core.js).
 * Runs headless under plain Node (`node --test test/`) instead of the Electron
 * app, so no manual setup/rerun is needed to check follow-up-question behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('a follow-up question is answered with the prior turn as context', async () => {
  const jarvis = createJarvis();

  await jarvis.processUserInput('When was Python created?');
  await jarvis.processUserInput('Who created it?');

  assert.equal(jarvis.llmCalls.length, 2);
  assert.deepEqual(jarvis.llmCalls[0].context, [], 'first question has no prior context');
  assert.deepEqual(jarvis.llmCalls[1].context, [
    { role: 'user', content: 'When was Python created?' },
    { role: 'assistant', content: 'mock-answer:1' }
  ], 'follow-up question sees the previous exchange');
});

test('conversation history stays capped at the last maxHistoryTurns entries', async () => {
  const jarvis = createJarvis();

  for (let i = 1; i <= 6; i++) {
    await jarvis.processUserInput(`Question number ${i}`);
  }

  assert.equal(jarvis.conversationHistory.length, jarvis.maxHistoryTurns);
  // Oldest turns must be dropped first — only the last 4 Q/A pairs remain.
  assert.equal(jarvis.conversationHistory[0].content, 'Question number 3');
  assert.equal(jarvis.conversationHistory.at(-2).content, 'Question number 6');
});

test('the Google-search branch also records and feeds conversation history', async () => {
  const jarvis = createJarvis();

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(jarvis.llmCalls.length, 1, 'search-synthesis LLM call happened');
  assert.deepEqual(jarvis.conversationHistory, [
    { role: 'user', content: 'What is the capital of France?' },
    { role: 'assistant', content: 'mock-answer:1' }
  ]);

  await jarvis.processUserInput('And its population?');

  assert.deepEqual(jarvis.llmCalls[1].context, [
    { role: 'user', content: 'What is the capital of France?' },
    { role: 'assistant', content: 'mock-answer:1' }
  ], 'second search question is answered with the first search turn as context');
});

test('empty input is ignored and does not touch conversation history', async () => {
  const jarvis = createJarvis();

  await jarvis.processUserInput('   ');

  assert.equal(jarvis.llmCalls.length, 0);
  assert.equal(jarvis.conversationHistory.length, 0);
});
