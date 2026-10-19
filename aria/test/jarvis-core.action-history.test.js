/**
 * Tests that every actionable dispatch block records its exchange into the
 * rolling conversation memory via _pushHistory (same user/assistant pair
 * convention as the MATH/GOOGLE_SEARCH/GMAIL/CALENDAR paths), so follow-ups
 * like "launch it again" resolve against prior LLM context.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

function historyContents(jarvis) {
  return jarvis.conversationHistory.map((m) => m.content);
}

test('"launch hollow knight" (Steam orchestrator path) is recorded into conversation memory', async () => {
  const jarvis = createJarvis();
  jarvis.gameLauncherOrchestrator.launchGame = async () => ({ success: true, gameName: 'Hollow Knight', message: 'Launching Hollow Knight, Sir.' });

  await jarvis.processUserInput('launch hollow knight');

  assert.deepEqual(historyContents(jarvis), ['launch hollow knight', 'Launching, Sir.']);
});

test('"launch hades on xbox" is recorded into conversation memory', async () => {
  const jarvis = createJarvis();
  jarvis.xboxHarness.launchGame = async () => ({ success: true, gameName: 'Hades II', message: 'Launching Hades II on Xbox, Sir.' });

  await jarvis.processUserInput('launch hades on xbox');

  assert.deepEqual(historyContents(jarvis), ['launch hades on xbox', 'Launching Hades II on Xbox, Sir.']);
});

test('"launch fortnite on epic" is recorded into conversation memory', async () => {
  const jarvis = createJarvis();
  jarvis.epicGamesHarness.launchGame = async () => ({ success: true, gameName: 'Fortnite', message: 'Launching Fortnite on Epic Games, Sir.' });

  await jarvis.processUserInput('launch fortnite on epic');

  assert.deepEqual(historyContents(jarvis), ['launch fortnite on epic', 'Launching Fortnite on Epic Games, Sir.']);
});

test('"play believer on spotify" is recorded into conversation memory', async () => {
  const jarvis = createJarvis();
  jarvis.spotifyHarness.playSong = async () => ({ message: 'Playing Believer on Spotify, Sir.', trackName: 'Believer' });

  await jarvis.processUserInput('play believer on spotify');

  assert.deepEqual(historyContents(jarvis), ['play believer on spotify', 'Playing Believer on Spotify, Sir.']);
});

test('"play my chill playlist from spotify" is recorded into conversation memory', async () => {
  const jarvis = createJarvis();
  jarvis.spotifyHarness.playFromLibrary = async () => ({ message: 'Playing your chill playlist, Sir.', matchedName: 'chill' });

  await jarvis.processUserInput('play my chill playlist from spotify');

  assert.deepEqual(historyContents(jarvis), ['play my chill playlist from spotify', 'Playing your chill playlist, Sir.']);
});

test('"open youtube" is recorded into conversation memory', async () => {
  const jarvis = createJarvis();
  jarvis.harness.openWebsite = () => ({ opened: true });

  await jarvis.processUserInput('open youtube');

  assert.deepEqual(historyContents(jarvis), ['open youtube', 'Opening YOUTUBE in a new tab Sir.']);
});

test('an applied model-tier switch is recorded into conversation memory', async () => {
  const jarvis = createJarvis();
  jarvis.groq.apiKey = 'fake-groq-key';

  await jarvis.processUserInput('switch mode to high');

  assert.deepEqual(historyContents(jarvis), ['switch mode to high', 'Switched to High mode, Sir.']);
});

test('a model-tier switch without the required key is NOT recorded into conversation memory', async () => {
  const jarvis = createJarvis(); // no Groq key configured

  await jarvis.processUserInput('switch mode to high');

  assert.deepEqual(jarvis.conversationHistory, []);
});

test('the recorded launch exchange feeds later conversational context (follow-up support)', async () => {
  const jarvis = createJarvis();
  jarvis.gameLauncherOrchestrator.launchGame = async () => ({ success: true, gameName: 'Hollow Knight', message: 'Launching Hollow Knight, Sir.' });

  await jarvis.processUserInput('launch hollow knight');
  await jarvis.processUserInput('thanks for that');

  assert.deepEqual(jarvis.llmCalls.at(-1).context, [
    { role: 'user', content: 'launch hollow knight' },
    { role: 'assistant', content: 'Launching, Sir.' }
  ], 'the follow-up question sees the launch exchange as prior context');
});
