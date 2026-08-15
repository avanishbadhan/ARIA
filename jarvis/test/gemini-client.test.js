import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../src/gemini-client.js';

function mockFetchOnce(responseBody) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => responseBody };
  };
  return calls;
}

test('a fresh client defaults to the ultra tier modelQueue', () => {
  const client = new GeminiClient('fake-key');
  assert.deepEqual(client.modelQueue, ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro']);
});

test('generateCompletion throws when no API key is configured', async () => {
  const client = new GeminiClient('');
  await assert.rejects(() => client.generateCompletion([{ role: 'user', content: 'hi' }]), /API Key not configured/);
});

test('generateCompletion converts OpenAI-style messages into Gemini system_instruction + contents', async () => {
  const calls = mockFetchOnce({ candidates: [{ content: { parts: [{ text: 'hi there' }] } }] });
  const client = new GeminiClient('fake-key');

  await client.generateCompletion([
    { role: 'system', content: 'You are JARVIS.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi, Sir.' },
    { role: 'user', content: 'how are you' }
  ]);

  assert.equal(calls[0].body.system_instruction.parts[0].text, 'You are JARVIS.');
  assert.deepEqual(calls[0].body.contents, [
    { role: 'user', parts: [{ text: 'hello' }] },
    { role: 'model', parts: [{ text: 'hi, Sir.' }] },
    { role: 'user', parts: [{ text: 'how are you' }] }
  ]);
});

test('generateCompletion hits the primary model with the API key in the query string', async () => {
  const calls = mockFetchOnce({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] });
  const client = new GeminiClient('fake-key');

  await client.generateCompletion([{ role: 'user', content: 'hi' }]);

  assert.ok(calls[0].url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent'));
  assert.ok(calls[0].url.includes('key=fake-key'));
});

test('generateCompletion retries the next model on a 404, and returns its answer', async () => {
  const calls = [];
  global.fetch = async (url) => {
    const model = url.match(/models\/([^:]+):/)[1];
    calls.push(model);
    if (model === 'gemini-2.5-pro') {
      return { status: 404, ok: false, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'fallback answer' }] } }] }) };
  };
  const client = new GeminiClient('fake-key');

  const result = await client.generateCompletion([{ role: 'user', content: 'hi' }]);

  assert.equal(result, 'fallback answer');
  assert.deepEqual(calls, ['gemini-2.5-pro', 'gemini-2.5-flash']);
});

test('generateCompletion throws once every model in the queue has failed', async () => {
  global.fetch = async () => ({ status: 429, ok: false, json: async () => ({}) });
  const client = new GeminiClient('fake-key');

  await assert.rejects(() => client.generateCompletion([{ role: 'user', content: 'hi' }]));
});

test('chatWithJarvis returns null instead of throwing when every model fails', async () => {
  global.fetch = async () => ({ status: 429, ok: false, json: async () => ({}) });
  const client = new GeminiClient('fake-key');

  const result = await client.chatWithJarvis('hi', []);

  assert.equal(result, null);
});

test('chatWithJarvis returns the model answer on success', async () => {
  mockFetchOnce({ candidates: [{ content: { parts: [{ text: 'The answer is 4, Sir.' } ] } }] });
  const client = new GeminiClient('fake-key');

  const result = await client.chatWithJarvis('what is 2+2', []);

  assert.equal(result, 'The answer is 4, Sir.');
});
