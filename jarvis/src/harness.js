/**
 * JARVIS Browser Automation & Google Search Harness
 * Executes Google searches, manages browser tabs, navigates URLs,
 * and fetches real-time web summaries for spoken answers.
 */

export class BrowserHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.onViewportUpdate = options.onViewportUpdate || (() => {});
    this.tabsOpened = 0;
  }

  /**
   * Evaluates natural language input for explicit web search or tab commands.
   */
  detectCommand(input) {
    const text = input.trim().toLowerCase();

    // 1. Explicit Google search intent
    const googleMatch = text.match(/(?:search google for|google search for|search google|google|look up|search for|find info on|search)\s+(.+)/i);
    if (googleMatch && googleMatch[1]) {
      return {
        type: 'GOOGLE_SEARCH',
        query: googleMatch[1].trim()
      };
    }

    // 2. Direct site open intent
    const siteMatch = text.match(/(?:open|launch|go to|navigate to)\s+(youtube|github|google|wikipedia|reddit|twitter|x|maps|gmail|amazon|news)/i);
    if (siteMatch && siteMatch[1]) {
      return {
        type: 'OPEN_SITE',
        site: siteMatch[1].toLowerCase()
      };
    }

    // 3. Open arbitrary URL intent
    const urlMatch = text.match(/(?:open|go to|visit)\s+(https?:\/\/[^\s]+|[a-z0-9-]+\.[a-z]{2,}[^\s]*)/i);
    if (urlMatch && urlMatch[1]) {
      let targetUrl = urlMatch[1];
      if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
      return {
        type: 'OPEN_URL',
        url: targetUrl
      };
    }

    return null;
  }

  /**
   * Executes a Google search in a new browser tab and updates HUD search viewport.
   */
  async executeGoogleSearch(query, openTabInBrowser = true) {
    const encodedQuery = encodeURIComponent(query);
    const googleSearchUrl = `https://www.google.com/search?q=${encodedQuery}`;
    
    this.onLog({
      type: 'HARNESS',
      message: `[GOOGLE HARNESS] Executing Search for: "${query}"`
    });

    let tabOpenedSuccess = false;
    if (openTabInBrowser) {
      try {
        const newTab = window.open(googleSearchUrl, '_blank', 'noopener,noreferrer');
        if (newTab) {
          this.tabsOpened++;
          tabOpenedSuccess = true;
          this.onLog({
            type: 'SUCCESS',
            message: `[TAB OPENED] Google Search Tab active (#${this.tabsOpened}): ${googleSearchUrl}`
          });
        } else {
          this.onLog({
            type: 'WARNING',
            message: `[POPUP NOTICE] Browser prevented popups automatically. HUD Viewport fallback active.`
          });
        }
      } catch (e) {
        console.warn("Window.open issue:", e);
      }
    }

    // Update HUD Search Viewport
    const iframeFallbackUrl = `https://www.bing.com/search?q=${encodedQuery}`;
    this.onViewportUpdate({
      title: `Google Search: "${query}"`,
      url: googleSearchUrl,
      iframeUrl: iframeFallbackUrl,
      query: query,
      tabOpened: tabOpenedSuccess
    });

    // Fetch real-time web summary so JARVIS speaks real knowledge
    const searchResultText = await this.fetchLiveSearchAnswer(query);

    return {
      query,
      googleSearchUrl,
      tabOpened: tabOpenedSuccess,
      summary: searchResultText
    };
  }

  /**
   * Opens targeted popular websites
   */
  openWebsite(siteName) {
    const siteMap = {
      youtube: 'https://www.youtube.com',
      github: 'https://github.com',
      google: 'https://www.google.com',
      wikipedia: 'https://www.wikipedia.org',
      reddit: 'https://www.reddit.com',
      twitter: 'https://twitter.com',
      x: 'https://x.com',
      maps: 'https://maps.google.com',
      gmail: 'https://mail.google.com',
      amazon: 'https://www.amazon.com',
      news: 'https://news.google.com'
    };

    const targetUrl = siteMap[siteName] || `https://www.google.com/search?q=${encodeURIComponent(siteName)}`;
    
    this.onLog({
      type: 'HARNESS',
      message: `[HARNESS ACTION] Opening ${siteName.toUpperCase()} -> ${targetUrl}`
    });

    const newTab = window.open(targetUrl, '_blank', 'noopener,noreferrer');
    if (newTab) {
      this.tabsOpened++;
      this.onLog({
        type: 'SUCCESS',
        message: `[TAB OPENED] Successfully opened ${siteName} tab (#${this.tabsOpened}).`
      });
    } else {
      this.onLog({
        type: 'WARNING',
        message: `[POPUP NOTICE] Tab blocked by browser popup setting.`
      });
    }

    this.onViewportUpdate({
      title: `${siteName.toUpperCase()}`,
      url: targetUrl,
      iframeUrl: targetUrl,
      query: siteName,
      tabOpened: Boolean(newTab)
    });

    return { siteName, url: targetUrl, success: Boolean(newTab) };
  }

  /**
   * Fetches real-time web summary using DuckDuckGo Instant Answer / Wikipedia API
   */
  async fetchLiveSearchAnswer(query) {
    try {
      // 1. Try DuckDuckGo Instant Answer API
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const response = await fetch(ddgUrl);
      if (response.ok) {
        const data = await response.json();
        if (data.AbstractText) return data.AbstractText;
        if (data.Answer) return data.Answer;
        if (data.RelatedTopics && data.RelatedTopics.length > 0 && data.RelatedTopics[0].Text) {
          return data.RelatedTopics[0].Text;
        }
      }
    } catch (e) {
      console.warn("DuckDuckGo fetch error, trying Wikipedia API...");
    }

    try {
      // 2. Try Wikipedia API fallback
      const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
      const wikiRes = await fetch(wikiUrl);
      if (wikiRes.ok) {
        const wikiData = await wikiRes.json();
        if (wikiData.extract) return wikiData.extract;
      }
    } catch (e) {
      console.warn("Wikipedia fetch error");
    }

    return `I have launched a Google search for "${query}". Check your active browser tab and HUD viewport for full details.`;
  }
}
