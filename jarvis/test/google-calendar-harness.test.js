import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { GoogleCalendarHarness } = await import('../src/google-calendar-harness.js');

function resetWindow() {
  global.window = {};
}

test('listUpcoming returns a not-connected message outside Electron', async () => {
  resetWindow();
  const harness = new GoogleCalendarHarness();
  const result = await harness.listUpcoming('id', 'secret');
  assert.equal(result.success, false);
  assert.match(result.message, /connect/i);
});

test('listUpcoming returns a spoken summary naming the next event', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    calendar: {
      listEvents: async () => ([
        { id: '1', title: 'Standup', start: '2026-08-16T09:00:00Z', end: '2026-08-16T09:30:00Z', description: 'Daily sync' },
        { id: '2', title: 'Design review', start: '2026-08-17T14:00:00Z', end: '2026-08-17T15:00:00Z', description: '' }
      ])
    }
  };
  const harness = new GoogleCalendarHarness();
  const result = await harness.listUpcoming('id', 'secret');
  assert.equal(result.success, true);
  assert.equal(result.events.length, 2);
  assert.match(result.message, /2 upcoming events/);
  assert.match(result.message, /Standup/);
});

test('listUpcoming reports no upcoming events without erroring', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, calendar: { listEvents: async () => [] } };
  const harness = new GoogleCalendarHarness();
  const result = await harness.listUpcoming('id', 'secret');
  assert.equal(result.success, true);
  assert.match(result.message, /no upcoming events/i);
});

test('listUpcoming returns a graceful failure message when the IPC call throws', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, calendar: { listEvents: async () => { throw new Error('Not connected to Google.'); } } };
  const harness = new GoogleCalendarHarness();
  const result = await harness.listUpcoming('id', 'secret');
  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to check/i);
});

test('search returns a spoken summary of the top match and forwards maxResults', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    calendar: {
      search: async (clientId, clientSecret, query, maxResults) => {
        calls.push({ clientId, clientSecret, query, maxResults });
        return [{ id: '1', title: '1:1 with Alex', start: '2026-08-18T10:00:00Z', end: '2026-08-18T10:30:00Z', description: '' }];
      }
    }
  };
  const harness = new GoogleCalendarHarness();
  const result = await harness.search('id', 'secret', 'alex');

  assert.equal(result.success, true);
  assert.match(result.message, /1:1 with Alex/);
  assert.deepEqual(calls, [{ clientId: 'id', clientSecret: 'secret', query: 'alex', maxResults: 10 }]);
});

test('search reports no matches without erroring', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, calendar: { search: async () => [] } };
  const harness = new GoogleCalendarHarness();
  const result = await harness.search('id', 'secret', 'nonexistent');
  assert.equal(result.success, true);
  assert.match(result.message, /didn't find/i);
});

test('createEvent parses a natural-language whenText and calls the bridge with ISO start/end', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    calendar: {
      createEvent: async (clientId, clientSecret, title, description, startISO, endISO) => {
        calls.push({ clientId, clientSecret, title, description, startISO, endISO });
        return { id: 'evt-1', title, start: startISO, end: endISO };
      }
    }
  };
  const harness = new GoogleCalendarHarness();
  const result = await harness.createEvent('id', 'secret', 'Standup', 'tomorrow at 3pm');

  assert.equal(result.success, true);
  assert.match(result.message, /scheduled 'Standup'/);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.title, 'Standup');
  assert.equal(call.description, '');
  assert.doesNotThrow(() => new Date(call.startISO).toISOString());
  assert.doesNotThrow(() => new Date(call.endISO).toISOString());
  // Default 60-minute duration: end must be exactly one hour after start.
  assert.equal(new Date(call.endISO).getTime() - new Date(call.startISO).getTime(), 3600000);
});

test('createEvent respects a custom durationMinutes', async () => {
  resetWindow();
  let captured;
  global.window.jarvisElectron = {
    isElectron: true,
    calendar: {
      createEvent: async (clientId, clientSecret, title, description, startISO, endISO) => {
        captured = { startISO, endISO };
        return { id: 'evt-2', title, start: startISO, end: endISO };
      }
    }
  };
  const harness = new GoogleCalendarHarness();
  const result = await harness.createEvent('id', 'secret', 'Focus block', 'tomorrow at 9am', 30);

  assert.equal(result.success, true);
  assert.equal(new Date(captured.endISO).getTime() - new Date(captured.startISO).getTime(), 1800000);
});

test('createEvent returns a fallback message for an unparseable whenText without calling the bridge', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    calendar: {
      createEvent: async (...args) => { calls.push(args); return { id: 'x' }; }
    }
  };
  const harness = new GoogleCalendarHarness();
  const result = await harness.createEvent('id', 'secret', 'Mystery event', 'zebra');

  assert.equal(result.success, false);
  assert.match(result.message, /couldn't figure out when/i);
  assert.deepEqual(calls, []);
});

test('createEvent returns a graceful failure message when the IPC call throws', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    calendar: {
      createEvent: async () => { throw new Error('Google API HTTP 403'); }
    }
  };
  const harness = new GoogleCalendarHarness();
  const result = await harness.createEvent('id', 'secret', 'Standup', 'tomorrow at 3pm');

  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to schedule/i);
});

test('createEvent returns a not-connected message outside Electron', async () => {
  resetWindow();
  const harness = new GoogleCalendarHarness();
  const result = await harness.createEvent('id', 'secret', 'Standup', 'tomorrow at 3pm');
  assert.equal(result.success, false);
  assert.match(result.message, /connect/i);
});
