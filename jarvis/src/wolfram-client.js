/**
 * WolframAlpha Client for JARVIS
 * Uses the Spoken Results API — purpose-built for voice assistants, returns
 * one ready-to-speak sentence instead of structured data that would need
 * formatting. Grounds math answers in a real computation instead of letting
 * the LLM guess (and potentially get arithmetic wrong).
 */

export class WolframClient {
  constructor(appId = '', options = {}) {
    this.appId = appId;
    this.onLog = options.onLog || (() => {});
  }

  /**
   * Resolves a math query to a spoken-ready answer sentence, or null if
   * unconfigured, the API errored, or WolframAlpha had no answer for it —
   * null triggers the LLM chat fallback in JarvisCore either way.
   */
  async solve(query) {
    if (!this.appId) return null;

    try {
      let spokenText;

      if (typeof window !== 'undefined' && window.jarvisElectron?.isElectron) {
        // Electron main process — plain Node HTTPS request, no browser CORS.
        spokenText = await window.jarvisElectron.solveMath(this.appId, query);
      } else {
        // Plain browser tab. Same CORS-proxy tiering as Steam: Vite's dev
        // server proxy in dev, public CORS proxy as a best-effort fallback
        // for a static/non-proxied deployment.
        const wolframPath = `/v1/spoken?appid=${encodeURIComponent(this.appId)}&i=${encodeURIComponent(query)}`;
        const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
        const apiUrl = isDev
          ? `/wolfram-api${wolframPath}`
          : `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://api.wolframalpha.com${wolframPath}`)}`;

        const response = await fetch(apiUrl);
        if (response.status === 501) {
          // WolframAlpha's documented "no spoken result for this query" response.
          spokenText = null;
        } else if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        } else {
          spokenText = await response.text();
        }
      }

      if (!spokenText) return null;

      this.onLog({ type: 'SUCCESS', message: `[WOLFRAM] "${query}" -> "${spokenText}"` });
      return spokenText;
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[WOLFRAM FALLBACK] ${err.message}` });
      return null;
    }
  }
}
