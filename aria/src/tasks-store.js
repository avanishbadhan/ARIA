/**
 * ARIA Tasks Store
 * Tiny localStorage-backed task list for the Tasks view. Pure data logic —
 * the DOM rendering lives in main.js so this stays unit-testable.
 * Each task: { id: string, text: string, done: boolean, createdAt: number }.
 */

const STORAGE_KEY = 'aria_tasks';

function readRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeRaw(tasks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (e) {
    // Storage full or unavailable — tasks simply don't persist this run.
  }
}

function normalize(task) {
  return {
    id: String(task?.id ?? `${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    text: String(task?.text ?? ''),
    done: Boolean(task?.done),
    createdAt: Number(task?.createdAt) || Date.now()
  };
}

export function loadTasks() {
  return readRaw()
    .filter(t => t && typeof t.text === 'string' && t.text.trim().length > 0)
    .map(normalize)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function saveTasks(tasks) {
  writeRaw((Array.isArray(tasks) ? tasks : []).map(normalize));
  return loadTasks();
}

export function addTask(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return loadTasks();
  const tasks = loadTasks();
  tasks.push(normalize({ text: trimmed, done: false, createdAt: Date.now() }));
  writeRaw(tasks);
  return tasks;
}

export function toggleTask(id) {
  const tasks = loadTasks().map(t =>
    t.id === String(id) ? { ...t, done: !t.done } : t
  );
  writeRaw(tasks);
  return tasks;
}

export function removeTask(id) {
  const tasks = loadTasks().filter(t => t.id !== String(id));
  writeRaw(tasks);
  return tasks;
}

export function clearCompleted() {
  const tasks = loadTasks().filter(t => !t.done);
  writeRaw(tasks);
  return tasks;
}
