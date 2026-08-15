import test from 'node:test';
import assert from 'node:assert/strict';
import { GroqClient } from '../src/groq-client.js';

function mockFetchOnce(responseBody) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => responseBody };
  };
  return calls;
}

test('a fresh client defaults to the quick tier modelQueue, including its gpt-oss-20b fallback', () => {
  const client = new GroqClient('fake-key');
  assert.deepEqual(client.modelQueue, ['llama-3.1-8b-instant', 'openai/gpt-oss-20b']);
});

test('setTier rebuilds modelQueue with that tier\'s fallback chain', () => {
  const client = new GroqClient('fake-key');
  client.setTier('quick');
  assert.deepEqual(client.modelQueue, ['llama-3.1-8b-instant', 'openai/gpt-oss-20b']);
});

test('generateCompletion retries with gpt-oss-20b when llama-3.1-8b-instant errors out', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    if (body.model === 'llama-3.1-8b-instant') {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'model_decommissioned' } }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'fallback answer' } }] }) };
  };
  const client = new GroqClient('fake-key');

  const result = await client.generateCompletion([{ role: 'user', content: 'hi' }]);

  assert.equal(result, 'fallback answer');
  assert.deepEqual(calls, ['llama-3.1-8b-instant', 'openai/gpt-oss-20b']);
});

test('generateVisionCompletion uses the dedicated vision model queue, not the text modelQueue', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'A terminal window.' } }] });
  const client = new GroqClient('fake-key');

  const result = await client.generateVisionCompletion([{ role: 'user', content: 'what is this?' }], { temperature: 0.3, maxTokens: 200 });

  assert.equal(result, 'A terminal window.');
  assert.equal(calls[0].body.model, client.visionModelQueue[0]);
  assert.notEqual(client.visionModelQueue[0], client.modelQueue[0]);
});

test('generateVisionCompletion disables chain-of-thought reasoning via reasoning_effort:"none"', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'A terminal window.' } }] });
  const client = new GroqClient('fake-key');

  await client.generateVisionCompletion([{ role: 'user', content: 'what is this?' }], { temperature: 0.3, maxTokens: 200 });

  assert.equal(calls[0].body.reasoning_effort, 'none');
});

test('generateVisionCompletion throws when no API key is configured', async () => {
  const client = new GroqClient('');
  await assert.rejects(() => client.generateVisionCompletion([{ role: 'user', content: 'hi' }]), /API Key not configured/);
});

test('generateCompletion forwards options.tools/toolExecutor to the request', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'hello' } }] });
  const client = new GroqClient('fake-key');
  const toolExecutor = async () => 'result';
  const tools = [{ type: 'function', function: { name: 'solve_math' } }];

  await client.generateCompletion([{ role: 'user', content: 'hi' }], { tools, toolExecutor });

  assert.equal(calls[0].body.tools[0].function.name, 'solve_math');
  assert.equal(calls[0].body.tool_choice, 'auto');
});

test('generateVisionCompletion forwards options.tools/toolExecutor to the request', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'A math problem: 2+2.' } }] });
  const client = new GroqClient('fake-key');
  const tools = [{ type: 'function', function: { name: 'solve_math' } }];

  await client.generateVisionCompletion([{ role: 'user', content: 'what is on screen?' }], { tools, toolExecutor: async () => '4' });

  assert.equal(calls[0].body.tools[0].function.name, 'solve_math');
});

test('chatWithJarvis forwards options.tools/toolExecutor through to generateCompletion', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'The answer is 4, Sir.' } }] });
  const client = new GroqClient('fake-key');
  const tools = [{ type: 'function', function: { name: 'solve_math' } }];

  await client.chatWithJarvis('what is 2+2', [], { tools, toolExecutor: async () => '4' });

  assert.equal(calls[0].body.tools[0].function.name, 'solve_math');
});
