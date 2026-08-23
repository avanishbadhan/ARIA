/**
 * Tests the input-serialization guard on JarvisCore.processUserInput:
 * overlapping transcripts (arriving faster than they're answered) must not
 * interleave conversation history or speech — while a run is in flight, the
 * newest incoming transcript is queued (max 1) and processed sequentially
 * once the in-flight run completes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('overlapping inputs queue behind the in-flight run and resolve sequentially', async () => {
  const jarvis = createJarvis();
  const gates = [];
  jarvis.openRouter.chatWithJarvis = async (input) => {
    jarvis.llmCalls.push(input);
    await new Promise((resolve) => gates.push(resolve));
    return `answer-for:${input}`;
  };

  const first = jarvis.processUserInput('good evening jarvis');
  while (!gates.length) await flush();

  // Second transcript arrives while the first run is still thinking/speaking.
  const second = jarvis.processUserInput('thank you jarvis');
  await flush();

  assert.equal(jarvis.llmCalls.length, 1, 'the queued input has not started processing yet');
  assert.equal(jarvis.conversationHistory.length, 0, 'no interleaved history writes while busy');

  gates[0]();
  while (gates.length < 2) await flush();
  assert.deepEqual(jarvis.llmCalls, ['good evening jarvis', 'thank you jarvis'], 'the queued input ran strictly after the first finished');
  assert.equal(jarvis.conversationHistory.length, 2, 'the first exchange was recorded before the queued one started');

  gates[1]();
  await first;
  await second;

  assert.deepEqual(
    jarvis.conversationHistory.map((m) => m.content),
    [
      'good evening jarvis', 'answer-for:good evening jarvis',
      'thank you jarvis', 'answer-for:thank you jarvis'
    ],
    'history reflects clean sequential exchanges'
  );
});

test('only the newest overlapping transcript stays queued (max 1)', async () => {
  const jarvis = createJarvis();
  const gates = [];
  jarvis.openRouter.chatWithJarvis = async (input) => {
    jarvis.llmCalls.push(input);
    await new Promise((resolve) => gates.push(resolve));
    return `answer-for:${input}`;
  };

  const first = jarvis.processUserInput('first request');
  while (!gates.length) await flush();

  jarvis.processUserInput('stale request');
  jarvis.processUserInput('newest request');

  gates[0]();
  while (gates.length < 2) await flush();

  assert.deepEqual(jarvis.llmCalls, ['first request', 'newest request'], 'the stale queued input was superseded by the newest one');

  gates[1]();
  await first;

  assert.deepEqual(
    jarvis.conversationHistory.map((m) => m.content),
    [
      'first request', 'answer-for:first request',
      'newest request', 'answer-for:newest request'
    ]
  );
});

test('sequential (non-overlapping) inputs are unaffected by the guard', async () => {
  const jarvis = createJarvis();

  await jarvis.processUserInput('first question');
  await jarvis.processUserInput('second question');

  assert.equal(jarvis.llmCalls.length, 2);
  assert.deepEqual(jarvis.llmCalls[1].context, [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'mock-answer:1' }
  ], 'each input still sees the prior exchange as context');
});
