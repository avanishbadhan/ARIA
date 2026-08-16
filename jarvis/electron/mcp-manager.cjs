/**
 * Spawns and manages a single long-lived Playwright MCP server process
 * (@playwright/mcp) via the Model Context Protocol SDK, exposing two
 * narrow read-only operations: fetchWebpageText (navigate + extract) and
 * browseAndExtract (navigate, optionally locate a link's context, extract).
 * Playwright MCP's full action surface (typing, form submission, downloads,
 * arbitrary clicking) is never exposed beyond these two functions — see
 * docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md.
 *
 * The MCP SDK is ESM-only, so it's loaded via dynamic import() from this
 * CommonJS file instead of require().
 */

const path = require('path');

let clientPromise = null;

// Matches the truncation length fetchGmailFullMessage() uses for long email
// bodies elsewhere in this codebase — keeps a single huge page from blowing
// the LLM's context.
const MAX_TEXT_LENGTH = 4000;

function extractText(callToolResult) {
  if (!callToolResult || !Array.isArray(callToolResult.content)) return '';
  const text = callToolResult.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + '…' : text;
}

async function getClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    // Resolve via package.json rather than a direct subpath require, since
    // package "exports" restrictions are more reliably permissive for the
    // manifest file than for arbitrary internal paths.
    const cliPath = path.join(require.resolve('@playwright/mcp/package.json'), '..', 'cli.js');

    // --headless: no visible browser window while JARVIS "reads a page".
    // --isolated: in-memory profile, nothing persisted to disk between runs.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, '--headless', '--isolated']
    });

    const client = new Client({ name: 'jarvis-voice-ai', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    // If the spawned process dies mid-session (crash, killed, etc.), clear
    // the cached promise so the *next* call respawns instead of reusing a
    // dead connection forever.
    client.onclose = () => { clientPromise = null; };

    return client;
  })();

  // If connecting fails outright, clear the cached promise so the *next*
  // call retries spawning instead of permanently caching a rejected
  // connection.
  clientPromise.catch(() => { clientPromise = null; });

  return clientPromise;
}

/**
 * Navigates to a URL and returns the extracted readable page text.
 */
async function fetchWebpageText(url) {
  const client = await getClient();
  await client.callTool({ name: 'browser_navigate', arguments: { url } });
  const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  return extractText(snapshot);
}

/**
 * Navigates to a URL and returns the extracted readable page text. If
 * linkText is given, first searches the page for it (via browser_find) and
 * prefixes the result with that match's context — this is a search within
 * the page, not an automated click-through (Playwright MCP's click-target
 * reference format isn't stable/documented enough to parse reliably from
 * text output; an automated "follow the link" step can be a fast follow
 * once that's verified against the live tool output).
 */
async function browseAndExtract(url, linkText) {
  const client = await getClient();
  await client.callTool({ name: 'browser_navigate', arguments: { url } });

  if (linkText) {
    const found = await client.callTool({ name: 'browser_find', arguments: { text: linkText } });
    const foundText = extractText(found);
    if (foundText) {
      return `Found "${linkText}" on the page:\n${foundText}`;
    }
  }

  const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  return extractText(snapshot);
}

module.exports = { fetchWebpageText, browseAndExtract };
