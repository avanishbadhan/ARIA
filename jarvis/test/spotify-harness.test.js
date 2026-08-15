import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { SpotifyHarness } = await import('../src/spotify-harness.js');

function resetWindow() {
  global.window = { location: { href: '' } };
}

test('openApp navigates to the spotify: URI and reports success', () => {
  resetWindow();
  const harness = new SpotifyHarness();
  const result = harness.openApp();

  assert.equal(global.window.location.href, 'spotify:');
  assert.equal(result.success, true);
});

test('playSong falls back to spotify:search when no credentials are configured', async () => {
  resetWindow();
  const harness = new SpotifyHarness();
  const result = await harness.playSong('believer', '', '');

  assert.equal(global.window.location.href, `spotify:search:${encodeURIComponent('believer')}`);
  assert.equal(result.success, false);
  assert.equal(result.usedFallback, true);
  assert.equal(result.query, 'believer');
});

test('playSong falls back to spotify:search when not running inside Electron, even with credentials', async () => {
  resetWindow();
  const harness = new SpotifyHarness();
  const result = await harness.playSong('believer', 'client-id', 'client-secret');

  assert.equal(global.window.location.href, `spotify:search:${encodeURIComponent('believer')}`);
  assert.equal(result.usedFallback, true);
});

test('playSong navigates to the resolved track URI and speaks the real name/artist when a match is found', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    spotifyResolveTrack: async () => ({
      uri: 'spotify:track:abc123',
      name: 'Believer',
      artist: 'Imagine Dragons'
    })
  };
  const harness = new SpotifyHarness();
  const result = await harness.playSong('believer', 'client-id', 'client-secret');

  assert.equal(global.window.location.href, 'spotify:track:abc123');
  assert.equal(result.success, true);
  assert.equal(result.trackName, 'Believer');
  assert.equal(result.artist, 'Imagine Dragons');
  assert.match(result.message, /Believer/);
  assert.match(result.message, /Imagine Dragons/);
});

test('playSong falls back to spotify:search when the resolver finds no match', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    spotifyResolveTrack: async () => null
  };
  const harness = new SpotifyHarness();
  const result = await harness.playSong('some obscure unreleased track', 'client-id', 'client-secret');

  assert.equal(global.window.location.href, `spotify:search:${encodeURIComponent('some obscure unreleased track')}`);
  assert.equal(result.usedFallback, true);
});

test('playSong falls back to spotify:search when the resolver throws (network/auth error)', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    spotifyResolveTrack: async () => { throw new Error('Spotify token HTTP 400'); }
  };
  const harness = new SpotifyHarness();
  const result = await harness.playSong('believer', 'bad-id', 'bad-secret');

  assert.equal(global.window.location.href, `spotify:search:${encodeURIComponent('believer')}`);
  assert.equal(result.usedFallback, true);
});

test('playFromLibrary asks the LLM fallback when the playlist fuzzy-match misses, and plays its pick', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    spotifyAuth: {
      status: async () => ({ authenticated: true }),
      getLibrary: async () => ({
        playlists: [{ name: 'Late Night Coding', uri: 'spotify:playlist:abc123' }],
        albums: []
      })
    }
  };
  const resolveCalls = [];
  const harness = new SpotifyHarness({
    resolveEntity: async (args) => { resolveCalls.push(args); return 'Late Night Coding'; }
  });

  const result = await harness.playFromLibrary(
    // "evening dev session" shares zero words with "Late Night Coding", so
    // SpotifyHarness._findBestMatch()'s word-overlap scoring (which has no
    // minimum-score threshold, unlike fuzzyMatchGameName) genuinely misses —
    // this is what forces the LLM fallback branch to actually run.
    { kind: 'playlist', query: 'evening dev session', alternatives: ['evening dev sessions'] },
    'client-id', 'client-secret'
  );

  assert.equal(global.window.location.href, 'spotify:playlist:abc123');
  assert.equal(result.success, true);
  assert.equal(result.matchedName, 'Late Night Coding');
  assert.equal(resolveCalls.length, 1);
  assert.equal(resolveCalls[0].kind, 'Spotify playlist');
  assert.deepEqual(resolveCalls[0].candidates, ['Late Night Coding']);
  assert.deepEqual(resolveCalls[0].alternatives, ['evening dev sessions']);
});

test('playFromLibrary falls back to search when the LLM fallback also finds nothing', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    spotifyAuth: {
      status: async () => ({ authenticated: true }),
      getLibrary: async () => ({ playlists: [{ name: 'Late Night Coding', uri: 'spotify:playlist:abc123' }], albums: [] })
    }
  };
  const harness = new SpotifyHarness({ resolveEntity: async () => 'NONE' });

  const result = await harness.playFromLibrary({ kind: 'playlist', query: 'some totally unowned playlist' }, 'client-id', 'client-secret');

  assert.equal(global.window.location.href, `spotify:search:${encodeURIComponent('some totally unowned playlist')}`);
  assert.equal(result.usedFallback, true);
});

test('playFromLibrary works for albums too, with the "Spotify album" kind label', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    spotifyAuth: {
      status: async () => ({ authenticated: true }),
      getLibrary: async () => ({ playlists: [], albums: [{ name: 'Random Access Memories', uri: 'spotify:album:xyz789' }] })
    }
  };
  const resolveCalls = [];
  const harness = new SpotifyHarness({ resolveEntity: async (args) => { resolveCalls.push(args); return 'Random Access Memories'; } });

  // "daft punk record" shares zero words with "Random Access Memories" —
  // forces the fast word-overlap match to miss so the fallback actually runs.
  const result = await harness.playFromLibrary({ kind: 'album', query: 'daft punk record' }, 'client-id', 'client-secret');

  assert.equal(result.success, true);
  assert.equal(resolveCalls[0].kind, 'Spotify album');
});
