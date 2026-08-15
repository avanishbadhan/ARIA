import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const {
  isUpdateSupported,
  getCurrentVersion,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  onUpdateState,
  getChangelog
} = await import('../src/update-manager.js');

test('isUpdateSupported is false when window.jarvisElectron is absent (browser dev mode)', () => {
  delete global.window.jarvisElectron;
  assert.equal(isUpdateSupported(), false);
});

test('all actions no-op safely when unsupported, instead of throwing', async () => {
  delete global.window.jarvisElectron;
  assert.equal(await getCurrentVersion(), null);
  assert.doesNotThrow(() => checkForUpdate());
  assert.doesNotThrow(() => downloadUpdate());
  assert.doesNotThrow(() => installUpdate());
  const unsubscribe = onUpdateState(() => {});
  assert.equal(typeof unsubscribe, 'function');
  assert.doesNotThrow(() => unsubscribe());
  assert.deepEqual(await getChangelog(), []);
});

test('isUpdateSupported is true and calls are delegated when running inside Electron', async () => {
  const calls = [];
  global.window.jarvisElectron = {
    update: {
      getVersion: () => 'stubbed',
      check: () => calls.push('check'),
      download: () => calls.push('download'),
      install: () => calls.push('install'),
      onState: (cb) => { calls.push('onState'); return () => calls.push('unsubscribed'); },
      getChangelog: () => { calls.push('getChangelog'); return Promise.resolve([{ version: '1.5.1', notes: '- fixed a bug' }]); }
    }
  };

  assert.equal(isUpdateSupported(), true);
  checkForUpdate();
  downloadUpdate();
  installUpdate();
  const unsubscribe = onUpdateState(() => {});
  unsubscribe();
  const changelog = await getChangelog();

  assert.deepEqual(calls, ['check', 'download', 'install', 'onState', 'unsubscribed', 'getChangelog']);
  assert.deepEqual(changelog, [{ version: '1.5.1', notes: '- fixed a bug' }]);

  delete global.window.jarvisElectron;
});
