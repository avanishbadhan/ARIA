import test from 'node:test';
import assert from 'node:assert/strict';

global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};

const { SteamLibrary } = await import('../src/steam-library.js');

function makeLibraryWithGames(games) {
  const lib = new SteamLibrary({ apiKey: 'key', steamId: 'id' });
  lib.library = games.map(name => ({ appid: name, name, nameLower: name.toLowerCase(), playtimeForever: 0 }));
  return lib;
}

test('findGame returns null when the library is empty', () => {
  const lib = new SteamLibrary({ apiKey: 'key', steamId: 'id' });
  assert.equal(lib.findGame('dota'), null);
});

test('findGame delegates to the shared fuzzy matcher and returns the matched library entry', () => {
  const lib = makeLibraryWithGames(['Dota 2', 'Counter-Strike 2']);
  const result = lib.findGame('dota');
  assert.equal(result.name, 'Dota 2');
  assert.equal(result.appid, 'Dota 2');
});

test('findGame returns null for an unrelated query', () => {
  const lib = makeLibraryWithGames(['Dota 2', 'Counter-Strike 2']);
  assert.equal(lib.findGame('some totally unrelated title'), null);
});

test('findGame now correctly normalizes a curly apostrophe (bug fix bundled with this delegation — see plan Amendment 2)', () => {
  const lib = makeLibraryWithGames(["Baldur's Gate 3", 'Dota 2']);
  const result = lib.findGame('baldur’s gate 3');
  assert.equal(result.name, "Baldur's Gate 3");
});
