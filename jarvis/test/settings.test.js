import test from 'node:test';
import assert from 'node:assert/strict';

global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};

const { loadSettings, saveSettings, DEFAULT_SETTINGS } = await import('../src/settings.js');

test('loadSettings returns defaults when nothing stored', () => {
  global.localStorage.store.clear();
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

test('saveSettings persists a partial update and loadSettings reflects it', () => {
  global.localStorage.store.clear();
  saveSettings({ openTabOnSearch: false });
  const settings = loadSettings();
  assert.equal(settings.openTabOnSearch, false);
  assert.equal(settings.voiceGender, DEFAULT_SETTINGS.voiceGender, 'unrelated defaults stay intact');
});

test('saveSettings merges over previous saves rather than replacing wholesale', () => {
  global.localStorage.store.clear();
  saveSettings({ voiceGender: 'female' });
  saveSettings({ soundMeterEnabled: false });
  const settings = loadSettings();
  assert.equal(settings.voiceGender, 'female');
  assert.equal(settings.soundMeterEnabled, false);
});

test('loadSettings falls back to defaults if the stored value is corrupt JSON', () => {
  global.localStorage.store.clear();
  global.localStorage.setItem('jarvis_settings', '{not valid json');
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});
