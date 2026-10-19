/**
 * Tests that a math query is routed to WolframAlpha and spoken directly when
 * answered, and falls through to the normal LLM chat path when WolframAlpha
 * has no key configured or returns no result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('a math query is answered by WolframAlpha directly, without an LLM call', async () => {
  const jarvis = createJarvis();
  jarvis.wolfram.solve = async () => 'The result is 8';

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('what is 5 plus 3');

  assert.equal(jarvis.llmCalls.length, 0, 'the LLM is never called when WolframAlpha already answered');
  assert.deepEqual(spoken, ['The result is 8']);
});

test('falls through to the LLM chat path when WolframAlpha has no answer', async () => {
  const jarvis = createJarvis();
  jarvis.wolfram.solve = async () => null; // no key configured, or API had no result

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('what is 5 plus 3');

  assert.equal(jarvis.llmCalls.length, 1, 'the LLM is used as a fallback');
  assert.match(jarvis.llmCalls[0].input, /5 plus 3/);
  assert.deepEqual(spoken, ['mock-answer:1']);
});

test('a non-math query never calls WolframAlpha', async () => {
  const jarvis = createJarvis();
  jarvis.wolframCalls = [];
  jarvis.wolfram.solve = async (query) => { jarvis.wolframCalls.push(query); return null; };

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.wolframCalls.length, 0);
});
