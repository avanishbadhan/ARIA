import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { GmailHarness } = await import('../src/gmail-harness.js');

function resetWindow() {
  global.window = {};
}

test('listRecent returns a not-connected message outside Electron', async () => {
  resetWindow();
  const harness = new GmailHarness();
  const result = await harness.listRecent('id', 'secret');
  assert.equal(result.success, false);
  assert.match(result.message, /connect/i);
});

test('listRecent returns a spoken summary naming the most recent message', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    gmail: {
      listMessages: async () => ([
        { id: '1', from: 'Alex Chen <alex@example.com>', subject: 'Q3 budget review', snippet: 'Here is the summary...', date: 'Mon, 1 Jan 2026' },
        { id: '2', from: 'Github <noreply@github.com>', subject: 'New PR', snippet: 'Someone opened a PR', date: 'Sun, 31 Dec 2025' }
      ])
    }
  };
  const harness = new GmailHarness();
  const result = await harness.listRecent('id', 'secret');
  assert.equal(result.success, true);
  assert.equal(result.messages.length, 2);
  assert.match(result.message, /Alex Chen/);
  assert.match(result.message, /Q3 budget review/);
});

test('listRecent reports an empty inbox without erroring', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, gmail: { listMessages: async () => [] } };
  const harness = new GmailHarness();
  const result = await harness.listRecent('id', 'secret');
  assert.equal(result.success, true);
  assert.match(result.message, /no recent messages/i);
});

test('listRecent returns a graceful failure message when the IPC call throws', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, gmail: { listMessages: async () => { throw new Error('Not connected to Google.'); } } };
  const harness = new GmailHarness();
  const result = await harness.listRecent('id', 'secret');
  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to check/i);
});

test('search returns a spoken summary of the top match and forwards maxResults', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    gmail: {
      search: async (clientId, clientSecret, query, maxResults) => {
        calls.push({ clientId, clientSecret, query, maxResults });
        return [{ id: '1', from: 'Recruiter <r@example.com>', subject: 'Following up', snippet: 'Just checking in...', date: 'Mon, 1 Jan 2026' }];
      }
    }
  };
  const harness = new GmailHarness();
  const result = await harness.search('id', 'secret', 'recruiter');

  assert.equal(result.success, true);
  assert.match(result.message, /Recruiter/);
  assert.deepEqual(calls, [{ clientId: 'id', clientSecret: 'secret', query: 'recruiter', maxResults: 10 }]);
});

test('search reports no matches without erroring', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, gmail: { search: async () => [] } };
  const harness = new GmailHarness();
  const result = await harness.search('id', 'secret', 'nonexistent');
  assert.equal(result.success, true);
  assert.match(result.message, /didn't find/i);
});

test('getMessage returns the formatted message body', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    gmail: { getMessage: async () => ({ id: '1', from: 'Alex Chen <alex@example.com>', subject: 'Q3 budget review', date: 'Mon, 1 Jan 2026', body: 'Here is the full budget breakdown.' }) }
  };
  const harness = new GmailHarness();
  const result = await harness.getMessage('id', 'secret', '1');
  assert.equal(result.success, true);
  assert.match(result.message, /Alex Chen/);
  assert.match(result.message, /budget breakdown/);
});

test('readMessage searches first, then reads the top match', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    gmail: {
      search: async (clientId, clientSecret, query, maxResults) => { calls.push(['search', query, maxResults]); return [{ id: 'abc', from: 'Sarah <sarah@example.com>', subject: 'Trip plans', snippet: '...', date: 'x' }]; },
      getMessage: async (clientId, clientSecret, id) => { calls.push(['get', id]); return { id, from: 'Sarah <sarah@example.com>', subject: 'Trip plans', date: 'x', body: "Let's go next week." }; }
    }
  };
  const harness = new GmailHarness();
  const result = await harness.readMessage('id', 'secret', 'sarah');

  assert.equal(result.success, true);
  assert.match(result.message, /Trip plans/);
  assert.deepEqual(calls, [['search', 'sarah', 1], ['get', 'abc']]);
});

test('readMessage reports no match without calling getMessage', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    gmail: {
      search: async () => { calls.push('search'); return []; },
      getMessage: async () => { calls.push('get'); return {}; }
    }
  };
  const harness = new GmailHarness();
  const result = await harness.readMessage('id', 'secret', 'nobody');

  assert.equal(result.success, false);
  assert.match(result.message, /couldn't find/i);
  assert.deepEqual(calls, ['search']);
});
