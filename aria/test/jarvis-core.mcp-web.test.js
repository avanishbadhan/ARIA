/**
 * Confirms McpWebHarness is actually wired into JarvisCore's toolExecutor,
 * not just imported — mirrors the shape of the Gmail/Calendar/Location
 * grounding-tool wiring tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('web_search grounding tool reaches the real McpWebHarness instance on JarvisCore', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.mcpWebHarness.fetchWebpage = async (url) => {
    calls.push(url);
    return { success: true, text: 'Search result text.' };
  };

  const result = await jarvis.toolExecutor('web_search', '{"query":"weather today"}');

  assert.equal(result, 'Search result text.');
  assert.deepEqual(calls, ['https://www.google.com/search?q=weather%20today']);
});

test('browse_webpage grounding tool reaches the real McpWebHarness instance on JarvisCore', async () => {
  const jarvis = createJarvis();
  const calls = [];
  jarvis.mcpWebHarness.browseWebpage = async (url, linkText) => {
    calls.push({ url, linkText });
    return { success: true, text: 'Page content.' };
  };

  const result = await jarvis.toolExecutor('browse_webpage', '{"url":"https://example.com","linkText":"about"}');

  assert.equal(result, 'Page content.');
  assert.deepEqual(calls, [{ url: 'https://example.com', linkText: 'about' }]);
});
