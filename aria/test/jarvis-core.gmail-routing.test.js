/**
 * Tests that Gmail commands are routed to GmailHarness and the harness's
 * spoken message is what actually gets spoken — no LLM involvement either
 * way. Mirrors jarvis-core.spotify-routing.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('"check my email" checks the inbox via GmailHarness and speaks its message', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.gmailHarness.listRecent = async (clientId, clientSecret) => {
    calls.push({ clientId, clientSecret });
    return { success: true, messages: [], message: 'Your inbox has no recent messages, Sir.' };
  };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('check my email');

  assert.equal(calls.length, 1);
  assert.equal(jarvis.llmCalls.length, 0);
  assert.deepEqual(spoken, ['Your inbox has no recent messages, Sir.']);
});

test('"search my email for the invoice" calls search with the parsed query', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.gmailHarness.search = async (clientId, clientSecret, query) => {
    calls.push(query);
    return { success: true, messages: [], message: `I didn't find any emails matching "${query}", Sir.` };
  };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('search my email for the invoice');

  assert.deepEqual(calls, ['the invoice']);
  assert.deepEqual(spoken, ['I didn\'t find any emails matching "the invoice", Sir.']);
});

test('"read me the email from sarah" calls readMessage with the parsed sender', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.gmailHarness.readMessage = async (clientId, clientSecret, query) => {
    calls.push(query);
    return { success: true, message: 'From Sarah, subject "Trip plans": Let\'s go next week.' };
  };
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('read me the email from sarah');

  assert.deepEqual(calls, ['sarah']);
  assert.deepEqual(spoken, ['From Sarah, subject "Trip plans": Let\'s go next week.']);
});

test('a Gmail harness failure result is still spoken as-is, not treated as a crash', async () => {
  const jarvis = createJarvis();
  jarvis.gmailHarness.listRecent = async () => ({ success: false, message: "Your Google account isn't connected yet. Connect it in Settings, Sir." });
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(text); };

  await jarvis.processUserInput('check my email');

  assert.deepEqual(spoken, ["Your Google account isn't connected yet. Connect it in Settings, Sir."]);
});

test('a non-Gmail query never calls GmailHarness', async () => {
  const jarvis = createJarvis();
  jarvis.gmailCalls = [];
  jarvis.gmailHarness.listRecent = async () => { jarvis.gmailCalls.push('listRecent'); return { success: true, message: '' }; };
  jarvis.voiceEngine.speak = async () => {};

  await jarvis.processUserInput('what is the capital of France');

  assert.equal(jarvis.gmailCalls.length, 0);
});

test('JarvisCore constructor wires this.googleClientId/this.googleClientSecret from localStorage', async () => {
  global.localStorage.setItem('jarvis_google_client_id', 'stored-id');
  global.localStorage.setItem('jarvis_google_client_secret', 'stored-secret');
  const jarvis = createJarvis();
  assert.equal(jarvis.googleClientId, 'stored-id');
  assert.equal(jarvis.googleClientSecret, 'stored-secret');
  global.localStorage.removeItem('jarvis_google_client_id');
  global.localStorage.removeItem('jarvis_google_client_secret');
});
