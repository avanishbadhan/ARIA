import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('core constructs a files harness wired into the tool executor', () => {
  global.localStorage.store.clear();
  const jarvis = createJarvis();
  assert.equal(typeof jarvis.filesHarness.writeNote, 'function');
  assert.equal(jarvis.pendingFileAction, null);
});

test('write_note saves a new note through the voice tool path', async () => {
  global.localStorage.store.clear();
  const jarvis = createJarvis();
  const out = await jarvis.toolExecutor('write_note', JSON.stringify({ filename: 'wifi password', content: 'hunter2' }));
  assert.match(out, /saved/i);
  const read = await jarvis.filesHarness.readNote('wifi password');
  assert.equal(read.content, 'hunter2');
});

test('write_note collision stages an overwrite pending action', async () => {
  global.localStorage.store.clear();
  const jarvis = createJarvis();
  await jarvis.toolExecutor('write_note', JSON.stringify({ filename: 'todo', content: 'first' }));
  const out = await jarvis.toolExecutor('write_note', JSON.stringify({ filename: 'todo', content: 'second' }));
  assert.match(out, /already exists/i);
  assert.equal(jarvis.pendingFileAction.type, 'overwrite');
  assert.equal(jarvis.pendingFileAction.filename, 'todo.md');
});

test('"yes" executes the staged overwrite instead of dispatching chat', async () => {
  global.localStorage.store.clear();
  const jarvis = createJarvis();
  const responses = [];
  jarvis.onResponse = (r) => responses.push(r);
  await jarvis.toolExecutor('write_note', JSON.stringify({ filename: 'todo', content: 'first' }));
  await jarvis.toolExecutor('write_note', JSON.stringify({ filename: 'todo', content: 'second' }));

  await jarvis.processUserInput('yes please');
  assert.equal((await jarvis.filesHarness.readNote('todo')).content, 'second');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].actionType, 'FILE_ACTION');
  assert.match(responses[0].text, /overwrote/i);
  assert.equal(jarvis.llmCalls.length, 0, 'confirmation must not reach the LLM');
});

test('"no" keeps the original and acknowledges', async () => {
  global.localStorage.store.clear();
  const jarvis = createJarvis();
  const responses = [];
  jarvis.onResponse = (r) => responses.push(r);
  await jarvis.toolExecutor('write_note', JSON.stringify({ filename: 'todo', content: 'first' }));
  await jarvis.toolExecutor('write_note', JSON.stringify({ filename: 'todo', content: 'second' }));

  await jarvis.processUserInput('no thanks');
  assert.equal((await jarvis.filesHarness.readNote('todo')).content, 'first');
  assert.match(responses[0].text, /nothing changed/i);
});

test('delete_note stages a delete that "yes" executes', async () => {
  global.localStorage.store.clear();
  const jarvis = createJarvis();
  const responses = [];
  jarvis.onResponse = (r) => responses.push(r);
  await jarvis.toolExecutor('write_note', JSON.stringify({ filename: 'scratch', content: 'x' }));

  const out = await jarvis.toolExecutor('delete_note', JSON.stringify({ filename: 'scratch' }));
  assert.match(out, /confirm/i);
  assert.equal(jarvis.pendingFileAction.type, 'delete');

  await jarvis.processUserInput('yes');
  assert.equal((await jarvis.filesHarness.readNote('scratch')).success, false);
  assert.match(responses[0].text, /deleted/i);
});

test('an expired pending action falls through to normal dispatch', async () => {
  global.localStorage.store.clear();
  const jarvis = createJarvis();
  await jarvis.toolExecutor('write_note', JSON.stringify({ filename: 'todo', content: 'first' }));
  jarvis.pendingFileAction = { type: 'overwrite', filename: 'todo.md', content: 'second', expiresAt: Date.now() - 1000 };

  await jarvis.processUserInput('yes');
  assert.equal((await jarvis.filesHarness.readNote('todo')).content, 'first');
  assert.equal(jarvis.pendingFileAction, null);
  assert.equal(jarvis.llmCalls.length, 1, 'expired pending must not swallow the command');
});

test('list_notes reads back what write_note saved, end to end', async () => {
  global.localStorage.store.clear();
  const jarvis = createJarvis();
  await jarvis.toolExecutor('write_note', JSON.stringify({ filename: 'ideas', content: 'build a robot' }));
  const out = await jarvis.toolExecutor('list_notes', '{}');
  assert.match(out, /ideas\.md/);
  assert.match(out, /build a robot/);
});
