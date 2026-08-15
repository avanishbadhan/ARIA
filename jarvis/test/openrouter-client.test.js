import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || { location: { origin: 'http://localhost:3000' } };

const { OpenRouterClient } = await import('../src/openrouter-client.js');

function mockFetchOnce(responseBody) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => responseBody };
  };
  return calls;
}

test('generateVisionCompletion uses the dedicated vision model queue, not the text modelQueue', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'A terminal window.' } }] });
  const client = new OpenRouterClient('fake-key');

  const result = await client.generateVisionCompletion([{ role: 'user', content: 'what is this?' }], { temperature: 0.3, maxTokens: 200 });

  assert.equal(result, 'A terminal window.');
  assert.equal(calls[0].body.model, client.visionModelQueue[0]);
  assert.equal(client.visionModelQueue[0], 'nvidia/nemotron-nano-12b-v2-vl:free');
});

test('generateVisionCompletion throws when no API key is configured', async () => {
  const client = new OpenRouterClient('');
  await assert.rejects(() => client.generateVisionCompletion([{ role: 'user', content: 'hi' }]), /API Key not configured/);
});

test('generateCompletion forwards options.tools/toolExecutor to the request', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'hello' } }] });
  const client = new OpenRouterClient('fake-key');
  const tools = [{ type: 'function', function: { name: 'web_search' } }];

  await client.generateCompletion([{ role: 'user', content: 'hi' }], { tools, toolExecutor: async () => 'result' });

  assert.equal(calls[0].body.tools[0].function.name, 'web_search');
  assert.equal(calls[0].body.tool_choice, 'auto');
});

test('generateVisionCompletion forwards options.tools/toolExecutor to the request', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'A math problem: 2+2.' } }] });
  const client = new OpenRouterClient('fake-key');
  const tools = [{ type: 'function', function: { name: 'solve_math' } }];

  await client.generateVisionCompletion([{ role: 'user', content: 'what is on screen?' }], { tools, toolExecutor: async () => '4' });

  assert.equal(calls[0].body.tools[0].function.name, 'solve_math');
});

test('chatWithJarvis forwards options.tools/toolExecutor through to generateCompletion', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'The answer is 4, Sir.' } }] });
  const client = new OpenRouterClient('fake-key');
  const tools = [{ type: 'function', function: { name: 'solve_math' } }];

  await client.chatWithJarvis('what is 2+2', [], { tools, toolExecutor: async () => '4' });

  assert.equal(calls[0].body.tools[0].function.name, 'solve_math');
});
