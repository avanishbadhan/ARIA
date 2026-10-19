/**
 * Tests that the nearby-places and directions feature is wired through
 * JarvisCore: the maps grounding tools are present in this.groundingTools and
 * handed to the toolExecutor, and the places/directions nudge fires for
 * representative phrasings ("pizza near me", "directions to the airport") so
 * the LLM is pushed to call get_location then the maps tools instead of
 * guessing from memory. See
 * docs/superpowers/specs/2026-08-16-nearby-places-and-directions-design.md.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';
import { saveSettings } from '../src/settings.js';
import { GROUNDING_TOOLS } from '../src/jarvis-tools.js';

beforeEach(() => {
  global.localStorage.store.clear();
});

test('maps tools are present in the grounding tools list', () => {
  const names = GROUNDING_TOOLS.map((t) => t.function.name);
  assert.ok(names.includes('find_nearby_places'));
  assert.ok(names.includes('get_directions'));
});

test('mapsHarness is present and the executor delegates to it', async () => {
  const jarvis = createJarvis();
  assert.ok(jarvis.mapsHarness);
  // Stub the harness so the executor's maps branch can be exercised without
  // Electron: it should resolve location and call findNearbyPlaces.
  const calls = [];
  jarvis.mapsHarness.findNearbyPlaces = async (lat, lon, query) => {
    calls.push({ lat, lon, query });
    return { success: true, places: [{ name: 'Slice House', distanceMi: 0.3, address: '123 Main St' }] };
  };
  jarvis.locationHarness.getCurrentPosition = async () => ({ success: true, lat: 40.7128, lon: -74.006 });
  const opened = [];
  jarvis.harness.openNearbyTab = (lat, lon, query) => opened.push({ lat, lon, query });

  const result = await jarvis.toolExecutor('find_nearby_places', '{"query":"pizza"}');

  assert.deepEqual(calls, [{ lat: 40.7128, lon: -74.006, query: 'pizza' }]);
  assert.match(result, /Slice House/);
  assert.deepEqual(opened, [{ lat: 40.7128, lon: -74.006, query: 'pizza' }]);
});

test('a "near me" GOOGLE_SEARCH prompt includes the places/directions nudge', async () => {
  const jarvis = createJarvis();
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input, context, options) => { jarvis.groqCalls.push(input); return 'answer'; };
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';

  await jarvis.processUserInput("what's a good coffee shop around here");

  assert.equal(jarvis.groqCalls.length, 1);
  assert.match(jarvis.groqCalls[0], /find_nearby_places/);
  assert.match(jarvis.groqCalls[0], /do NOT guess an address or business from memory/i);
});

test('a "directions to" CONVERSATIONAL prompt includes the places/directions nudge', async () => {
  const jarvis = createJarvis();
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input, context, options) => { jarvis.groqCalls.push(input); return 'answer'; };
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';

  await jarvis.processUserInput('directions to the airport');

  assert.equal(jarvis.groqCalls.length, 1);
  assert.match(jarvis.groqCalls[0], /get_directions/);
  assert.match(jarvis.groqCalls[0], /call get_location first/i);
});

test('a "closest X from here" GOOGLE_SEARCH prompt skips the search and forces the maps tool', async () => {
  let searchRan = false;
  const jarvis = createJarvis({
    executeGoogleSearch: async () => { searchRan = true; return { summary: 'unused' }; }
  });
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input, context, options) => { jarvis.groqCalls.push(input); return 'answer'; };
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';

  await jarvis.processUserInput('what is the closest ice cream place from here');

  assert.equal(searchRan, false, 'a places query must not trigger a web search');
  assert.equal(jarvis.groqCalls.length, 1);
  assert.match(jarvis.groqCalls[0], /find_nearby_places/);
  assert.doesNotMatch(jarvis.groqCalls[0], /search results/i);
});

test('a "nearest X to my location" CONVERSATIONAL prompt includes the places/directions nudge', async () => {
  const jarvis = createJarvis();
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input, context, options) => { jarvis.groqCalls.push(input); return 'answer'; };
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';

  await jarvis.processUserInput('use my location and find the nearest baskin robbins');

  assert.equal(jarvis.groqCalls.length, 1);
  assert.match(jarvis.groqCalls[0], /find_nearby_places/);
  assert.match(jarvis.groqCalls[0], /call get_location first/i);
});

test('a GOOGLE_SEARCH classification with a trimmed query ("pizza", dropping "near me") still skips the real web search', async () => {
  // Regression test: the AI intent classifier commonly extracts a bare
  // search query from a place request, trimming a qualifier like "near me"
  // as noise (e.g. "find pizza near me" -> params.query: "pizza"). The
  // places/directions check must test the raw user input, not
  // decision.params.query, or this silently falls through to a real web
  // search instead of the maps tools. Same lesson as the SCREEN_QUERY
  // reclassification guard elsewhere in jarvis-core.js.
  const jarvis = createJarvis();
  jarvis._classifyIntentWithAI = async () => JSON.stringify({
    toolName: 'GOOGLE_SEARCH', confidence: 0.9, params: { query: 'pizza' }, reasoning: 'x'
  });
  let searchCalled = false;
  jarvis.harness.executeGoogleSearch = async () => { searchCalled = true; return { summary: 'some web result' }; };
  jarvis.groq.chatWithJarvis = async () => 'answer';
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';

  await jarvis.processUserInput('find pizza near me');

  assert.equal(searchCalled, false);
});

test('an unrelated question does not include the places/directions nudge', async () => {
  const jarvis = createJarvis();
  jarvis.groqCalls = [];
  jarvis.groq.chatWithJarvis = async (input, context, options) => { jarvis.groqCalls.push(input); return 'answer'; };
  saveSettings({ useGroq: true });
  jarvis.groq.apiKey = 'fake-groq-key';

  await jarvis.processUserInput('What is the capital of France?');

  assert.equal(jarvis.groqCalls.length, 1);
  assert.doesNotMatch(jarvis.groqCalls[0], /find_nearby_places/);
  assert.doesNotMatch(jarvis.groqCalls[0], /get_directions/);
});
