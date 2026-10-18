/**
 * Tests that the Google-search branch actually grounds JARVIS's spoken
 * answer in the live web search result, instead of preferring the LLM's own
 * (possibly stale/wrong) training knowledge over real search data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('a search-triggering question grounds the LLM prompt in the search summary', async () => {
  const jarvis = createJarvis({
    executeGoogleSearch: async () => ({ summary: 'Paris is the capital of France, with a population of about 2.1 million.' })
  });

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(jarvis.llmCalls.length, 1);
  assert.match(
    jarvis.llmCalls[0].input,
    /Paris is the capital of France/,
    'the LLM prompt includes the real search summary as grounding context'
  );
});

test('falls back to an ungrounded prompt when the search returns no summary', async () => {
  const jarvis = createJarvis({
    executeGoogleSearch: async () => ({ summary: '' })
  });

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(jarvis.llmCalls.length, 1);
  assert.doesNotMatch(
    jarvis.llmCalls[0].input,
    /search results/i,
    'no grounding block is added when there is nothing to ground with'
  );
});

test('the raw-summary fallback (LLM unavailable) is trimmed to 2 sentences, not 3', async () => {
  const jarvis = createJarvis({
    executeGoogleSearch: async () => ({
      summary: 'Sentence one is here. Sentence two follows next. Sentence three should be cut. Sentence four too.'
    })
  });
  jarvis.openRouter.chatWithJarvis = async () => null; // simulate both LLM providers unavailable

  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(spoken.length, 1);
  assert.equal(spoken[0], 'Sentence one is here. Sentence two follows next.');
});
