import test from 'node:test';
import assert from 'node:assert/strict';

global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};
global.window = global.window || {};

const { FileSystemHarness } = await import('../src/file-harness.js');

function resetEnv() {
  global.window = {};
  global.localStorage.store.clear();
}

function useElectron(filesMock) {
  global.window = { jarvisElectron: { isElectron: true, files: filesMock } };
}

test('writeNote delegates to the Electron bridge when present', async () => {
  resetEnv();
  const calls = [];
  useElectron({
    write: async (filename, content, overwrite) => {
      calls.push({ filename, content, overwrite });
      return { success: true, filename: 'game-ideas.md' };
    }
  });
  const harness = new FileSystemHarness();
  const result = await harness.writeNote('game ideas', 'content', false);
  assert.equal(result.success, true);
  assert.equal(result.filename, 'game-ideas.md');
  assert.deepEqual(calls, [{ filename: 'game ideas', content: 'content', overwrite: false }]);
});

test('readNote/listNotes/deleteNote delegate to the Electron bridge when present', async () => {
  resetEnv();
  useElectron({
    read: async (filename) => ({ success: true, content: `contents of ${filename}` }),
    list: async () => ({ success: true, files: [{ filename: 'a.md', preview: 'hi', modifiedAt: 5 }] }),
    delete: async (filename) => ({ success: true })
  });
  const harness = new FileSystemHarness();
  assert.equal((await harness.readNote('a')).content, 'contents of a');
  assert.equal((await harness.listNotes()).files.length, 1);
  assert.equal((await harness.deleteNote('a')).success, true);
});

test('localStorage fallback round-trips a write/read/list/delete outside Electron', async () => {
  resetEnv();
  const harness = new FileSystemHarness();
  const written = await harness.writeNote('wifi password', 'hunter2');
  assert.equal(written.success, true);
  assert.equal(written.filename, 'wifi-password.md');

  const read = await harness.readNote('wifi password');
  assert.equal(read.success, true);
  assert.equal(read.content, 'hunter2');

  const listed = await harness.listNotes();
  assert.equal(listed.success, true);
  assert.equal(listed.files.length, 1);
  assert.equal(listed.files[0].filename, 'wifi-password.md');
  assert.match(listed.files[0].preview, /hunter2/);

  const deleted = await harness.deleteNote('wifi password');
  assert.equal(deleted.success, true);
  assert.equal((await harness.listNotes()).files.length, 0);
});

test('fallback refuses a second write without overwrite, then honors overwrite', async () => {
  resetEnv();
  const harness = new FileSystemHarness();
  await harness.writeNote('todo', 'first');
  const second = await harness.writeNote('todo', 'second');
  assert.equal(second.success, false);
  assert.equal(second.exists, true);
  assert.equal(second.filename, 'todo.md');

  const overwrite = await harness.writeNote('todo', 'second', true);
  assert.equal(overwrite.success, true);
  assert.equal((await harness.readNote('todo')).content, 'second');
});

test('fallback sanitizes names and re-saving a listed name is idempotent', async () => {
  resetEnv();
  const harness = new FileSystemHarness();
  const written = await harness.writeNote('My WiFi Password!', 'x');
  assert.equal(written.filename, 'my-wifi-password.md');

  // A listed name ('x.md') must not corrupt into 'xmd.md' on re-save.
  const relisted = await harness.writeNote('my-wifi-password.md', 'y', true);
  assert.equal(relisted.success, true);
  assert.equal((await harness.listNotes()).files.length, 1);
  assert.equal((await harness.readNote('my-wifi-password')).content, 'y');

  const traversal = await harness.writeNote('../evil', 'x');
  assert.equal(traversal.success, false);

  const blank = await harness.writeNote('!!!', 'x');
  assert.equal(blank.success, false);
});

test('fallback read/delete of a missing note report it cleanly', async () => {
  resetEnv();
  const harness = new FileSystemHarness();
  assert.equal((await harness.readNote('ghost')).success, false);
  assert.match((await harness.readNote('ghost')).message, /no note/i);
  assert.equal((await harness.deleteNote('ghost')).success, false);
});

test('fallback lists most-recently-modified first with first-line previews', async () => {
  resetEnv();
  global.localStorage.setItem('aria_notes_v1', JSON.stringify({
    'old.md': { content: 'Old note body here', modifiedAt: 1000 },
    'new.md': { content: 'New note body here\nsecond line', modifiedAt: 2000 }
  }));
  const harness = new FileSystemHarness();
  const listed = await harness.listNotes();
  assert.deepEqual(listed.files.map((f) => f.filename), ['new.md', 'old.md']);
  assert.equal(listed.files[0].preview, 'New note body here');
});

test('fallback survives corrupt storage without throwing', async () => {
  resetEnv();
  global.localStorage.setItem('aria_notes_v1', '{not valid json');
  const harness = new FileSystemHarness();
  assert.deepEqual((await harness.listNotes()).files, []);
  assert.equal((await harness.writeNote('fresh', 'ok')).success, true);
});
