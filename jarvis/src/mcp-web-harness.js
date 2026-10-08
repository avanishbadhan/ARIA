/**
 * JARVIS MCP Web Harness — real webpage reading via the Playwright MCP
 * server, spawned and driven entirely in the Electron main process (see
 * electron/mcp-manager.cjs). Unlike GmailHarness/GoogleCalendarHarness this
 * needs no credentials and no account connection — just the Electron IPC
 * bridge, which only exists in the packaged/dev-Electron app, not in plain
 * dev-browser mode (localhost:3000 without Electron). See
 * docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md.
 */

export class McpWebHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.mcp;
  }

  _notAvailable() {
    return { success: false, message: 'Web browsing is not available outside the ARIA desktop app, Sir.' };
  }

  /**
   * Navigates to a URL and returns the extracted readable page text.
   */
  async fetchWebpage(url) {
    if (!this._isElectron()) return this._notAvailable();
    try {
      const text = await window.jarvisElectron.mcp.fetchWebpage(url);
      if (!text) return { success: false, message: `I found no readable content at ${url}, Sir.` };
      this.onLog({ type: 'SUCCESS', message: `[MCP WEB] Fetched ${url} (${text.length} chars).` });
      return { success: true, text };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[MCP WEB] fetchWebpage failed: ${err.message}` });
      return { success: false, message: `I wasn't able to read ${url}, Sir.` };
    }
  }

  /**
   * Navigates to a URL, optionally searches the page for linkText, and
   * returns the extracted readable text (see browseAndExtract in
   * mcp-manager.cjs for exactly what "optionally" means here).
   */
  async browseWebpage(url, linkText) {
    if (!this._isElectron()) return this._notAvailable();
    try {
      const text = await window.jarvisElectron.mcp.browseWebpage(url, linkText);
      if (!text) return { success: false, message: `I found no readable content at ${url}, Sir.` };
      this.onLog({ type: 'SUCCESS', message: `[MCP WEB] Browsed ${url} (${text.length} chars).` });
      return { success: true, text };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[MCP WEB] browseWebpage failed: ${err.message}` });
      return { success: false, message: `I wasn't able to read ${url}, Sir.` };
    }
  }
}
