import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUNDING_TOOLS, createToolExecutor } from '../src/jarvis-tools.js';

test('GROUNDING_TOOLS only lists read-only tools, no action tools', () => {
  const names = GROUNDING_TOOLS.map(t => t.function.name);
  assert.deepEqual(names, ['solve_math', 'web_search', 'list_recent_emails', 'search_emails', 'list_upcoming_events', 'search_calendar_events', 'get_location', 'get_weather', 'browse_webpage', 'find_nearby_places', 'get_directions']);
});

test('solve_math delegates to wolfram.solve with the parsed query', async () => {
  const calls = [];
  const wolfram = { solve: async (query) => { calls.push(query); return 'The result is 4.'; } };
  const executor = createToolExecutor({ wolfram, harness: null });

  const result = await executor('solve_math', '{"query":"2+2"}');

  assert.equal(result, 'The result is 4.');
  assert.deepEqual(calls, ['2+2']);
});

test('solve_math returns a graceful fallback string when wolfram has no answer', async () => {
  const wolfram = { solve: async () => null };
  const executor = createToolExecutor({ wolfram, harness: null });

  const result = await executor('solve_math', '{"query":"2+2"}');

  assert.match(result, /unavailable|no result/i);
});

test('solve_math returns a graceful fallback string when wolfram.solve throws', async () => {
  const wolfram = { solve: async () => { throw new Error('network error'); } };
  const executor = createToolExecutor({ wolfram, harness: null });

  const result = await executor('solve_math', '{"query":"2+2"}');

  assert.match(result, /unavailable|no result/i);
});

test('web_search builds a Google search URL and delegates to mcpWeb.fetchWebpage', async () => {
  const calls = [];
  const mcpWeb = { fetchWebpage: async (url) => { calls.push(url); return { success: true, text: 'Paris is the capital of France.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('web_search', '{"query":"capital of France"}');

  assert.equal(result, 'Paris is the capital of France.');
  assert.deepEqual(calls, ['https://www.google.com/search?q=capital%20of%20France']);
});

test('web_search returns a graceful fallback string when mcpWeb reports failure', async () => {
  const mcpWeb = { fetchWebpage: async () => ({ success: false, message: 'not available' }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('web_search', '{"query":"xyz"}');

  assert.equal(result, 'No web search result found for this query.');
});

test('web_search returns a graceful fallback string when mcpWeb.fetchWebpage throws', async () => {
  const mcpWeb = { fetchWebpage: async () => { throw new Error('network error'); } };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('web_search', '{"query":"xyz"}');

  assert.equal(result, 'No web search result found for this query.');
});

test('web_search returns a graceful fallback string when mcpWeb is not wired up', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  const result = await executor('web_search', '{"query":"xyz"}');

  assert.equal(result, 'No web search result found for this query.');
});

test('unknown tool names resolve to a descriptive string instead of throwing', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  const result = await executor('launch_missiles', '{}');

  assert.match(result, /unknown tool/i);
});

test('unparseable arguments resolve to a descriptive string instead of throwing', async () => {
  const executor = createToolExecutor({ wolfram: { solve: async () => 'x' }, harness: null });

  const result = await executor('solve_math', 'not json');

  assert.match(result, /invalid/i);
});

test('get_weather delegates to weather.getCurrentWeather with the parsed lat/lon', async () => {
  const calls = [];
  const weather = {
    getCurrentWeather: async (lat, lon) => {
      calls.push({ lat, lon });
      return { success: true, temperatureC: 22, feelsLikeC: 21, humidityPct: 40, windKmph: 12, description: 'partly cloudy' };
    }
  };
  const executor = createToolExecutor({ wolfram: null, harness: null, weather });

  const result = await executor('get_weather', '{"lat":37.7749,"lon":-122.4194}');

  assert.deepEqual(calls, [{ lat: 37.7749, lon: -122.4194 }]);
  assert.match(result, /22°C/);
  assert.match(result, /partly cloudy/);
});

test('get_weather returns a graceful fallback when the weather harness reports failure', async () => {
  const weather = { getCurrentWeather: async () => ({ success: false }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, weather });

  const result = await executor('get_weather', '{"lat":1,"lon":2}');

  assert.match(result, /unable to retrieve/i);
});

test('get_weather returns a fallback when no weather harness is available', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  const result = await executor('get_weather', '{"lat":1,"lon":2}');

  assert.match(result, /unable to retrieve/i);
});

test('list_recent_emails delegates to gmail.listRecent using the stored Google credentials', async () => {
  const calls = [];
  const gmail = { listRecent: async (clientId, clientSecret) => { calls.push({ clientId, clientSecret }); return { success: true, messages: [{}], message: 'You have 1 recent email.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, gmail, getGoogleCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }) });

  const result = await executor('list_recent_emails', '{}');

  assert.equal(result, 'You have 1 recent email.');
  assert.deepEqual(calls, [{ clientId: 'id', clientSecret: 'secret' }]);
});

test('list_recent_emails returns a graceful fallback string when Gmail reports failure', async () => {
  const gmail = { listRecent: async () => ({ success: false, message: 'not connected' }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, gmail, getGoogleCredentials: () => ({ clientId: '', clientSecret: '' }) });

  const result = await executor('list_recent_emails', '{}');

  assert.match(result, /not connected|no matching/i);
});

test('search_emails delegates to gmail.search with the parsed query', async () => {
  const calls = [];
  const gmail = { search: async (clientId, clientSecret, query) => { calls.push(query); return { success: true, messages: [{}], message: 'Found it.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, gmail, getGoogleCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }) });

  const result = await executor('search_emails', '{"query":"recruiter"}');

  assert.equal(result, 'Found it.');
  assert.deepEqual(calls, ['recruiter']);
});

test('search_emails returns a graceful fallback string when gmail.search throws', async () => {
  const gmail = { search: async () => { throw new Error('network error'); } };
  const executor = createToolExecutor({ wolfram: null, harness: null, gmail, getGoogleCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }) });

  const result = await executor('search_emails', '{"query":"recruiter"}');

  assert.match(result, /not connected|no matching/i);
});

test('list_recent_emails and search_emails fall back gracefully when gmail/getGoogleCredentials are not wired up', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  assert.match(await executor('list_recent_emails', '{}'), /not connected|no matching/i);
  assert.match(await executor('search_emails', '{"query":"x"}'), /not connected|no matching/i);
});

test('list_upcoming_events delegates to calendar.listUpcoming using the stored Google credentials', async () => {
  const calls = [];
  const calendar = { listUpcoming: async (clientId, clientSecret) => { calls.push({ clientId, clientSecret }); return { success: true, events: [{}], message: 'You have 1 upcoming event. The next is ...' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, calendar, getGoogleCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }) });

  const result = await executor('list_upcoming_events', '{}');

  assert.equal(result, 'You have 1 upcoming event. The next is ...');
  assert.deepEqual(calls, [{ clientId: 'id', clientSecret: 'secret' }]);
});

test('list_upcoming_events returns a graceful fallback string when the calendar reports failure', async () => {
  const calendar = { listUpcoming: async () => ({ success: false, message: 'not connected' }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, calendar, getGoogleCredentials: () => ({ clientId: '', clientSecret: '' }) });

  const result = await executor('list_upcoming_events', '{}');

  assert.match(result, /not connected|no matching/i);
});

test('search_calendar_events delegates to calendar.search with the parsed query', async () => {
  const calls = [];
  const calendar = { search: async (clientId, clientSecret, query) => { calls.push(query); return { success: true, events: [{}], message: 'Found it.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, calendar, getGoogleCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }) });

  const result = await executor('search_calendar_events', '{"query":"standup"}');

  assert.equal(result, 'Found it.');
  assert.deepEqual(calls, ['standup']);
});

test('search_calendar_events returns a graceful fallback string when calendar.search throws', async () => {
  const calendar = { search: async () => { throw new Error('network error'); } };
  const executor = createToolExecutor({ wolfram: null, harness: null, calendar, getGoogleCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }) });

  const result = await executor('search_calendar_events', '{"query":"standup"}');

  assert.match(result, /not connected|no matching/i);
});

test('list_upcoming_events and search_calendar_events fall back gracefully when calendar/getGoogleCredentials are not wired up', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  assert.match(await executor('list_upcoming_events', '{}'), /not connected|no matching/i);
  assert.match(await executor('search_calendar_events', '{"query":"x"}'), /not connected|no matching/i);
});

test('get_location returns the coordinates when location resolves successfully', async () => {
  const location = { getCurrentPosition: async () => ({ success: true, lat: 40.7128, lon: -74.006 }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, location });

  const result = await executor('get_location', '{}');
  assert.match(result, /40\.71280/);
  assert.match(result, /-74\.00600/);
});

test('get_location returns a graceful message when location permission is denied', async () => {
  const location = { getCurrentPosition: async () => ({ success: false, message: "You've blocked location access, Sir." }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, location });

  assert.match(await executor('get_location', '{}'), /blocked location/i);
});

test('get_location returns a graceful fallback when location.getCurrentPosition throws', async () => {
  const location = { getCurrentPosition: async () => { throw new Error('boom'); } };
  const executor = createToolExecutor({ wolfram: null, harness: null, location });

  assert.match(await executor('get_location', '{}'), /unable to determine/i);
});

test('get_location falls back gracefully when location is not wired up', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  assert.match(await executor('get_location', '{}'), /not available|unable to determine/i);
});

test('browse_webpage delegates to mcpWeb.browseWebpage with the parsed url and linkText', async () => {
  const calls = [];
  const mcpWeb = { browseWebpage: async (url, linkText) => { calls.push({ url, linkText }); return { success: true, text: 'Pricing: $10/month.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('browse_webpage', '{"url":"https://example.com","linkText":"pricing"}');

  assert.equal(result, 'Pricing: $10/month.');
  assert.deepEqual(calls, [{ url: 'https://example.com', linkText: 'pricing' }]);
});

test('browse_webpage works without linkText (url only)', async () => {
  const calls = [];
  const mcpWeb = { browseWebpage: async (url, linkText) => { calls.push({ url, linkText }); return { success: true, text: 'Homepage content.' }; } };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('browse_webpage', '{"url":"https://example.com"}');

  assert.equal(result, 'Homepage content.');
  assert.deepEqual(calls, [{ url: 'https://example.com', linkText: undefined }]);
});

test('browse_webpage returns a graceful fallback string when mcpWeb reports failure', async () => {
  const mcpWeb = { browseWebpage: async () => ({ success: false, message: 'not available' }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('browse_webpage', '{"url":"https://example.com"}');

  assert.equal(result, 'Unable to read that webpage.');
});

test('browse_webpage returns a graceful fallback string when mcpWeb.browseWebpage throws', async () => {
  const mcpWeb = { browseWebpage: async () => { throw new Error('navigation timeout'); } };
  const executor = createToolExecutor({ wolfram: null, harness: null, mcpWeb });

  const result = await executor('browse_webpage', '{"url":"https://example.com"}');

  assert.equal(result, 'Unable to read that webpage.');
});

test('browse_webpage returns a graceful fallback string when mcpWeb is not wired up', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  const result = await executor('browse_webpage', '{"url":"https://example.com"}');

  assert.equal(result, 'Unable to read that webpage.');
});

test('find_nearby_places delegates to maps.findNearbyPlaces, opening a nearby tab on success', async () => {
  const calls = [];
  const openedTabs = [];
  const maps = {
    findNearbyPlaces: async (lat, lon, query) => {
      calls.push({ lat, lon, query });
      return { success: true, places: [
        { name: 'Slice House', distanceMi: 0.3, address: '123 Main St' },
        { name: 'Pizza Palace', distanceMi: 0.9, address: '45 Oak Ave' }
      ] };
    }
  };
  const location = { getCurrentPosition: async () => ({ success: true, lat: 40.7128, lon: -74.006 }) };
  const harness = { openNearbyTab: (lat, lon, query) => openedTabs.push({ lat, lon, query }) };
  const executor = createToolExecutor({ wolfram: null, harness, location, maps });

  const result = await executor('find_nearby_places', '{"query":"pizza"}');

  assert.deepEqual(calls, [{ lat: 40.7128, lon: -74.006, query: 'pizza' }]);
  assert.match(result, /Slice House/);
  assert.match(result, /0\.3mi/);
  assert.match(result, /123 Main St/);
  assert.deepEqual(openedTabs, [{ lat: 40.7128, lon: -74.006, query: 'pizza' }]);
});

test('find_nearby_places uses provided lat/lon args instead of resolving location', async () => {
  const calls = [];
  const maps = {
    findNearbyPlaces: async (lat, lon, query) => {
      calls.push({ lat, lon, query });
      return { success: true, places: [{ name: 'Brew', distanceMi: 0.5, address: '1 Park Ln' }] };
    }
  };
  const harness = { openNearbyTab: () => {} };
  const executor = createToolExecutor({ wolfram: null, harness, maps });

  const result = await executor('find_nearby_places', '{"query":"coffee","lat":10,"lon":20}');

  assert.deepEqual(calls, [{ lat: 10, lon: 20, query: 'coffee' }]);
  assert.match(result, /Brew/);
});

test('find_nearby_places returns a graceful fallback when maps reports failure, and opens no tab', async () => {
  const maps = { findNearbyPlaces: async () => ({ success: false, message: "I couldn't find anything nearby, Sir." }) };
  let opened = false;
  const harness = { openNearbyTab: () => { opened = true; } };
  const location = { getCurrentPosition: async () => ({ success: true, lat: 1, lon: 2 }) };
  const executor = createToolExecutor({ wolfram: null, harness, location, maps });

  const result = await executor('find_nearby_places', '{"query":"pizza"}');

  assert.match(result, /couldn't find anything nearby/i);
  assert.equal(opened, false);
});

test('find_nearby_places returns a graceful fallback when no maps harness is wired up', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  const result = await executor('find_nearby_places', '{"query":"pizza"}');

  assert.match(result, /couldn't find anything nearby/i);
});

test('find_nearby_places returns a fallback when location cannot be resolved', async () => {
  const maps = { findNearbyPlaces: async () => ({ success: true, places: [] }) };
  const location = { getCurrentPosition: async () => ({ success: false }) };
  const executor = createToolExecutor({ wolfram: null, harness: null, location, maps });

  const result = await executor('find_nearby_places', '{"query":"pizza"}');

  assert.match(result, /couldn't find anything nearby/i);
});

test('get_directions delegates to maps.getDirections, opening a directions tab on success', async () => {
  const calls = [];
  const openedTabs = [];
  const maps = {
    getDirections: async (lat, lon, destination) => {
      calls.push({ lat, lon, destination });
      return { success: true, distanceMi: 4.2, durationMin: 12, destinationLabel: 'Airport' };
    }
  };
  const location = { getCurrentPosition: async () => ({ success: true, lat: 40.7128, lon: -74.006 }) };
  const harness = { openDirectionsTab: (lat, lon, destination) => openedTabs.push({ lat, lon, destination }) };
  const executor = createToolExecutor({ wolfram: null, harness, location, maps });

  const result = await executor('get_directions', '{"destination":"the airport"}');

  assert.deepEqual(calls, [{ lat: 40.7128, lon: -74.006, destination: 'the airport' }]);
  assert.match(result, /4\.2 miles/);
  assert.match(result, /12 minutes/);
  assert.deepEqual(openedTabs, [{ lat: 40.7128, lon: -74.006, destination: 'the airport' }]);
});

test('get_directions returns a graceful fallback when maps reports failure, and opens no tab', async () => {
  const maps = { getDirections: async () => ({ success: false, message: "I couldn't find that place, Sir." }) };
  let opened = false;
  const harness = { openDirectionsTab: () => { opened = true; } };
  const location = { getCurrentPosition: async () => ({ success: true, lat: 1, lon: 2 }) };
  const executor = createToolExecutor({ wolfram: null, harness, location, maps });

  const result = await executor('get_directions', '{"destination":"the airport"}');

  assert.match(result, /couldn't find that place/i);
  assert.equal(opened, false);
});

test('get_directions returns a graceful fallback when no maps harness is wired up', async () => {
  const executor = createToolExecutor({ wolfram: null, harness: null });

  const result = await executor('get_directions', '{"destination":"the airport"}');

  assert.match(result, /couldn't find that place/i);
});
