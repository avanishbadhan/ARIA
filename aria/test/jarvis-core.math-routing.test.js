/**
 * Tests that a math query is routed to WolframAlpha and spoken directly when
 * answered, and falls through to the normal LLM chat path when WolframAlpha
 * has no key configured or returns no result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('a math query is answered by WolframAlpha directly in voice; the LLM call only produces the typeset display work', async () => {
  const jarvis = createJarvis();
  jarvis.wolfram.solve = async () => 'The result is 8';

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };
  const displays = [];
  jarvis.onDisplay = (payload) => displays.push(payload);

  await jarvis.processUserInput('what is 5 plus 3');

  assert.deepEqual(spoken, ['The result is 8'], 'the spoken answer is WolframAlpha verbatim');
  assert.equal(jarvis.llmCalls.length, 1, 'the LLM is only called for the typeset work');
  assert.match(jarvis.llmCalls[0].input, /step by step/);
  assert.match(jarvis.llmCalls[0].input, /what is 5 plus 3/);
  assert.equal(displays.length, 1);
  assert.equal(displays[0].kind, 'text');
  assert.equal(displays[0].body, 'mock-answer:1', 'the display shows the typeset work');
});

test('falls through to the LLM chat path when WolframAlpha has no answer', async () => {
  const jarvis = createJarvis();
  jarvis.wolfram.solve = async () => null; // no key configured, or API had no result

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };
  const displays = [];
  jarvis.onDisplay = (payload) => displays.push(payload);

  await jarvis.processUserInput('what is 5 plus 3');

  assert.equal(jarvis.llmCalls.length, 2, 'the LLM answers the voice query and produces the display work');
  assert.match(jarvis.llmCalls[0].input, /5 plus 3/, 'the first call is the voice answer');
  assert.match(jarvis.llmCalls[1].input, /step by step/, 'the second call is the typeset work');
  assert.deepEqual(spoken, ['mock-answer:1']);
  assert.equal(displays.length, 1);
  assert.equal(displays[0].body, 'mock-answer:2', 'the display shows the typeset work');
});

test('a non-math query never calls WolframAlpha', async () => {
  const jarvis = createJarvis();
  jarvis.wolframCalls = [];
  jarvis.wolfram.solve = async (query) => { jarvis.wolframCalls.push(query); return null; };

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.wolframCalls.length, 0);
});
