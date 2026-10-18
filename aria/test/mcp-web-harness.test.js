import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { McpWebHarness } = await import('../src/mcp-web-harness.js');

function resetWindow() {
  global.window = {};
}

test('fetchWebpage returns a not-available message outside Electron', async () => {
  resetWindow();
  const harness = new McpWebHarness();
  const result = await harness.fetchWebpage('https://example.com');
  assert.equal(result.success, false);
  assert.match(result.message, /not available/i);
});

test('fetchWebpage delegates to window.jarvisElectron.mcp.fetchWebpage and returns the extracted text', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    mcp: { fetchWebpage: async (url) => `Page content for ${url}` }
  };
  const harness = new McpWebHarness();
  const result = await harness.fetchWebpage('https://example.com');
  assert.equal(result.success, true);
  assert.equal(result.text, 'Page content for https://example.com');
});

test('fetchWebpage returns a graceful failure message when the IPC call throws', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    mcp: { fetchWebpage: async () => { throw new Error('MCP server crashed'); } }
  };
  const harness = new McpWebHarness();
  const result = await harness.fetchWebpage('https://example.com');
  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to read/i);
});

test('fetchWebpage returns a graceful message when the page has no extractable text', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    mcp: { fetchWebpage: async () => '' }
  };
  const harness = new McpWebHarness();
  const result = await harness.fetchWebpage('https://example.com');
  assert.equal(result.success, false);
  assert.match(result.message, /no readable content/i);
});

test('browseWebpage returns a not-available message outside Electron', async () => {
  resetWindow();
  const harness = new McpWebHarness();
  const result = await harness.browseWebpage('https://example.com', 'pricing');
  assert.equal(result.success, false);
  assert.match(result.message, /not available/i);
});

test('browseWebpage delegates to window.jarvisElectron.mcp.browseWebpage with the url and linkText', async () => {
  resetWindow();
  const calls = [];
  global.window.jarvisElectron = {
    isElectron: true,
    mcp: {
      browseWebpage: async (url, linkText) => {
        calls.push({ url, linkText });
        return 'Found "pricing" on the page: $10/month';
      }
    }
  };
  const harness = new McpWebHarness();
  const result = await harness.browseWebpage('https://example.com', 'pricing');
  assert.equal(result.success, true);
  assert.equal(result.text, 'Found "pricing" on the page: $10/month');
  assert.deepEqual(calls, [{ url: 'https://example.com', linkText: 'pricing' }]);
});

test('browseWebpage returns a graceful failure message when the IPC call throws', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    mcp: { browseWebpage: async () => { throw new Error('navigation timeout'); } }
  };
  const harness = new McpWebHarness();
  const result = await harness.browseWebpage('https://example.com');
  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to read/i);
});
