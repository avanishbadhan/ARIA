import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJarvisMessages } from '../src/llm-persona.js';

test('buildJarvisMessages puts a system prompt first and the user message last', () => {
  const messages = buildJarvisMessages('What time is it?', []);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /J\.A\.R\.V\.I\.S/);
  assert.deepEqual(messages.at(-1), { role: 'user', content: 'What time is it?' });
});

test('buildJarvisMessages includes prior context between the system and user messages', () => {
  const context = [
    { role: 'user', content: 'Who created Python?' },
    { role: 'assistant', content: 'Guido van Rossum, Sir.' }
  ];
  const messages = buildJarvisMessages('When?', context);
  assert.equal(messages.length, 4); // system + 2 context + user
  assert.deepEqual(messages[1], context[0]);
  assert.deepEqual(messages[2], context[1]);
});

test('buildJarvisMessages keeps only the last 6 context entries', () => {
  const context = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const messages = buildJarvisMessages('latest question', context);
  assert.equal(messages.length, 8); // system + 6 context + user
  assert.equal(messages[1].content, 'msg 4'); // last 6 of 10 = indices 4..9
});
