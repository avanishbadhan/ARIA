import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchChatCompletion } from '../src/llm-completion.js';

function mockFetchOnce(responseBody) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => responseBody
    };
  };
  return calls;
}

test('fetchChatCompletion sends the default temperature and max_tokens when not specified', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'hello' } }] });

  await fetchChatCompletion({
    baseUrl: 'https://example.test/chat',
    headers: {},
    modelQueue: ['some-model'],
    messages: [{ role: 'user', content: 'hi' }],
    logPrefix: 'TEST'
  });

  assert.equal(calls[0].body.temperature, 0.7);
  assert.equal(calls[0].body.max_tokens, 350);
});

test('fetchChatCompletion forwards a custom temperature and maxTokens through to the request body', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'Elden Ring' } }] });

  const result = await fetchChatCompletion({
    baseUrl: 'https://example.test/chat',
    headers: {},
    modelQueue: ['some-model'],
    messages: [{ role: 'user', content: 'hi' }],
    logPrefix: 'TEST',
    temperature: 0.1,
    maxTokens: 30
  });

  assert.equal(calls[0].body.temperature, 0.1);
  assert.equal(calls[0].body.max_tokens, 30);
  assert.equal(result, 'Elden Ring');
});

test('fetchChatCompletion merges extraBody fields into the request body', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'hello' } }] });

  await fetchChatCompletion({
    baseUrl: 'https://example.test/chat',
    headers: {},
    modelQueue: ['qwen/qwen3.6-27b'],
    messages: [{ role: 'user', content: 'hi' }],
    logPrefix: 'TEST',
    extraBody: { reasoning_effort: 'none' }
  });

  assert.equal(calls[0].body.reasoning_effort, 'none');
});

test('fetchChatCompletion strips a closed <think>...</think> block and returns only the final answer', async () => {
  mockFetchOnce({ choices: [{ message: { content: '<think>let me work this out...</think>The answer is 1458.' } }] });

  const result = await fetchChatCompletion({
    baseUrl: 'https://example.test/chat',
    headers: {},
    modelQueue: ['some-reasoning-model'],
    messages: [{ role: 'user', content: 'what is 27 times 54' }],
    logPrefix: 'TEST'
  });

  assert.equal(result, 'The answer is 1458.');
});

test('fetchChatCompletion treats an unclosed <think> block (ran out of tokens mid-thought) as empty and tries the next model', async () => {
  const calls = [];
  let call = 0;
  global.fetch = async (url, init) => {
    call += 1;
    calls.push({ url, body: JSON.parse(init.body) });
    if (call === 1) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: '<think>still reasoning and never finished' } }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'The answer is 1458.' } }] }) };
  };

  const result = await fetchChatCompletion({
    baseUrl: 'https://example.test/chat',
    headers: {},
    modelQueue: ['reasoning-model-that-truncates', 'backup-model'],
    messages: [{ role: 'user', content: 'what is 27 times 54' }],
    logPrefix: 'TEST'
  });

  assert.equal(result, 'The answer is 1458.');
  assert.equal(calls.length, 2);
});

test('fetchChatCompletion omits the tools field entirely when no tools are passed', async () => {
  const calls = mockFetchOnce({ choices: [{ message: { content: 'hello' } }] });

  await fetchChatCompletion({
    baseUrl: 'https://example.test/chat',
    headers: {},
    modelQueue: ['some-model'],
    messages: [{ role: 'user', content: 'hi' }],
    logPrefix: 'TEST'
  });

  assert.equal('tools' in calls[0].body, false);
  assert.equal('tool_choice' in calls[0].body, false);
});

test('fetchChatCompletion executes a tool_calls response and re-queries the same model with the result', async () => {
  const calls = [];
  let call = 0;
  global.fetch = async (url, init) => {
    call += 1;
    calls.push({ url, body: JSON.parse(init.body) });
    if (call === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'solve_math', arguments: '{"query":"2+2"}' } }]
            }
          }]
        })
      };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'The answer is 4, Sir.' } }] }) };
  };

  const toolCallsMade = [];
  const toolExecutor = async (name, argsJson) => {
    toolCallsMade.push({ name, argsJson });
    return '4';
  };

  const result = await fetchChatCompletion({
    baseUrl: 'https://example.test/chat',
    headers: {},
    modelQueue: ['some-model'],
    messages: [{ role: 'user', content: 'what is 2+2' }],
    logPrefix: 'TEST',
    tools: [{ type: 'function', function: { name: 'solve_math' } }],
    toolExecutor
  });

  assert.equal(result, 'The answer is 4, Sir.');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.tools[0].function.name, 'solve_math');
  assert.equal(calls[0].body.tool_choice, 'auto');
  assert.deepEqual(toolCallsMade, [{ name: 'solve_math', argsJson: '{"query":"2+2"}' }]);

  // Second request carries the assistant tool_calls message plus the tool result.
  const secondMessages = calls[1].body.messages;
  assert.equal(secondMessages.at(-2).tool_calls[0].function.name, 'solve_math');
  assert.equal(secondMessages.at(-1).role, 'tool');
  assert.equal(secondMessages.at(-1).tool_call_id, 'call_1');
  assert.equal(secondMessages.at(-1).content, '4');
});

test('fetchChatCompletion does not attempt tool execution when tools are passed but no toolExecutor is given', async () => {
  const calls = mockFetchOnce({
    choices: [{
      message: {
        role: 'assistant',
        content: 'I cannot look that up, Sir.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'solve_math', arguments: '{}' } }]
      }
    }]
  });

  const result = await fetchChatCompletion({
    baseUrl: 'https://example.test/chat',
    headers: {},
    modelQueue: ['some-model'],
    messages: [{ role: 'user', content: 'hi' }],
    logPrefix: 'TEST',
    tools: [{ type: 'function', function: { name: 'solve_math' } }]
  });

  assert.equal(result, 'I cannot look that up, Sir.');
  assert.equal(calls.length, 1);
});

test('multi-round tool calling chains get_location then get_weather across 3 API calls', async () => {
  const calls = [];
  let call = 0;
  global.fetch = async (url, init) => {
    call += 1;
    calls.push({ url, body: JSON.parse(init.body) });
    if (call === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'loc_1', type: 'function', function: { name: 'get_location', arguments: '{}' } }]
            }
          }]
        })
      };
    }
    if (call === 2) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'w_1', type: 'function', function: { name: 'get_weather', arguments: '{"lat":37.77,"lon":-122.41}' } }]
            }
          }]
        })
      };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'It is 22°C and partly cloudy, Sir.' } }] }) };
  };

  const toolCallsMade = [];
  const toolExecutor = async (name, argsJson) => {
    toolCallsMade.push({ name, argsJson });
    if (name === 'get_location') return 'latitude 37.7749, longitude -122.4194';
    if (name === 'get_weather') return '22°C, partly cloudy, 62% humidity';
    return 'unknown tool';
  };

  const result = await fetchChatCompletion({
    baseUrl: 'https://example.test/chat',
    headers: {},
    modelQueue: ['some-model'],
    messages: [{ role: 'user', content: 'what is the temperature here' }],
    logPrefix: 'TEST',
    tools: [
      { type: 'function', function: { name: 'get_location' } },
      { type: 'function', function: { name: 'get_weather' } }
    ],
    toolExecutor
  });

  assert.equal(result, 'It is 22°C and partly cloudy, Sir.');
  assert.equal(calls.length, 3);
  assert.deepEqual(toolCallsMade, [
    { name: 'get_location', argsJson: '{}' },
    { name: 'get_weather', argsJson: '{"lat":37.77,"lon":-122.41}' }
  ]);

  // Second request carries the original user message + get_location call + tool result
  const round1Messages = calls[1].body.messages;
  assert.equal(round1Messages.length, 3);
  assert.equal(round1Messages.at(-2).tool_calls[0].function.name, 'get_location');
  assert.equal(round1Messages.at(-1).role, 'tool');
  assert.equal(round1Messages.at(-1).tool_call_id, 'loc_1');
  assert.equal(round1Messages.at(-1).content, 'latitude 37.7749, longitude -122.4194');

  // Third request carries everything: user + get_location pair + get_weather pair
  const round2Messages = calls[2].body.messages;
  assert.equal(round2Messages.length, 5);
  assert.equal(round2Messages.at(-2).tool_calls[0].function.name, 'get_weather');
  assert.equal(round2Messages.at(-1).role, 'tool');
  assert.equal(round2Messages.at(-1).tool_call_id, 'w_1');
  assert.equal(round2Messages.at(-1).content, '22°C, partly cloudy, 62% humidity');
});

test('multi-round tool calling stops after MAX_TOOL_ROUNDS and falls through to the next model when the final message is still a tool call', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `c${calls.length}`, type: 'function', function: { name: 'ping', arguments: '{}' } }]
          }
        }]
      })
    };
  };

  const toolCallsMade = [];
  let threw = false;
  try {
    await fetchChatCompletion({
      baseUrl: 'https://example.test/chat',
      headers: {},
      modelQueue: ['stuck-loop-model'],
      messages: [{ role: 'user', content: 'hi' }],
      logPrefix: 'TEST',
      tools: [{ type: 'function', function: { name: 'ping' } }],
      toolExecutor: async (name) => { toolCallsMade.push(name); return 'pong'; }
    });
  } catch (err) {
    threw = true;
    assert.match(err.message, /Empty completion/);
  }

  assert.equal(threw, true, 'should throw after exhausting the model queue on a stuck tool loop');
  assert.equal(toolCallsMade.length, 4, 'should execute at most MAX_TOOL_ROUNDS tool calls');
  assert.equal(calls.length, 5, '1 initial + 4 follow-up calls across the one model');
});
