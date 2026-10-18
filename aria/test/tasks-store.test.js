import test from 'node:test';
import assert from 'node:assert/strict';

global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};

const { loadTasks, saveTasks, addTask, toggleTask, removeTask, clearCompleted } = await import('../src/tasks-store.js');

test('loadTasks returns an empty array when nothing is stored', () => {
  global.localStorage.store.clear();
  assert.deepEqual(loadTasks(), []);
});

test('addTask appends a trimmed, incomplete task and persists it', () => {
  global.localStorage.store.clear();
  const tasks = addTask('  Study physics  ');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, 'Study physics');
  assert.equal(tasks[0].done, false);
  assert.deepEqual(loadTasks(), tasks);
});

test('addTask ignores blank input', () => {
  global.localStorage.store.clear();
  assert.deepEqual(addTask('   '), []);
});

test('toggleTask flips done without touching other tasks', () => {
  global.localStorage.store.clear();
  addTask('one');
  const two = addTask('two')[1];
  const toggled = toggleTask(two.id);
  assert.equal(toggled[0].done, false);
  assert.equal(toggled[1].done, true);
  assert.equal(toggleTask(two.id)[1].done, false);
});

test('removeTask drops only the matching task', () => {
  global.localStorage.store.clear();
  const tasks = addTask('one');
  const id = tasks[0].id;
  addTask('two');
  const remaining = removeTask(id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].text, 'two');
});

test('clearCompleted keeps only incomplete tasks', () => {
  global.localStorage.store.clear();
  addTask('done-task');
  const tasks = addTask('open-task');
  toggleTask(tasks[0].id);
  const remaining = clearCompleted();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].text, 'open-task');
});

test('loadTasks falls back to empty on corrupt JSON and drops blank entries', () => {
  global.localStorage.store.clear();
  global.localStorage.setItem('aria_tasks', '{not valid json');
  assert.deepEqual(loadTasks(), []);
  saveTasks([{ id: 'a', text: '  ', done: false, createdAt: 1 }, { id: 'b', text: 'real', done: true, createdAt: 2 }]);
  const tasks = loadTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, 'real');
});
