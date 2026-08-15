import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { GoogleAccountConnector } = await import('../src/google-account-connector.js');

function resetWindow() {
  global.window = {};
}

test('authStatus returns not-authenticated when not running inside Electron', async () => {
  resetWindow();
  const connector = new GoogleAccountConnector();
  const result = await connector.authStatus();
  assert.equal(result.authenticated, false);
});

test('authStatus delegates to window.jarvisElectron.googleAuth.status()', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, googleAuth: { status: async () => ({ authenticated: true }) } };
  const connector = new GoogleAccountConnector();
  const result = await connector.authStatus();
  assert.equal(result.authenticated, true);
});

test('authStatus returns not-authenticated when the bridge call throws', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, googleAuth: { status: async () => { throw new Error('IPC error'); } } };
  const connector = new GoogleAccountConnector();
  const result = await connector.authStatus();
  assert.equal(result.authenticated, false);
});

test('login throws outside Electron instead of silently doing nothing', async () => {
  resetWindow();
  const connector = new GoogleAccountConnector();
  await assert.rejects(() => connector.login('id', 'secret'), /desktop app/i);
});

test('login delegates to window.jarvisElectron.googleAuth.login() with the credentials', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = { isElectron: true, googleAuth: { login: async (id, secret) => { calls.push({ id, secret }); return { success: true }; } } };
  const connector = new GoogleAccountConnector();
  const result = await connector.login('client-id', 'client-secret');
  assert.equal(result.success, true);
  assert.deepEqual(calls, [{ id: 'client-id', secret: 'client-secret' }]);
});

test('logout resolves to success outside Electron without calling anything', async () => {
  resetWindow();
  const connector = new GoogleAccountConnector();
  const result = await connector.logout();
  assert.equal(result.success, true);
});

test('logout delegates to window.jarvisElectron.googleAuth.logout()', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = { isElectron: true, googleAuth: { logout: async () => { calls.push(1); return { success: true }; } } };
  const connector = new GoogleAccountConnector();
  await connector.logout();
  assert.equal(calls.length, 1);
});
