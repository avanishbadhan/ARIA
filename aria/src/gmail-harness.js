/**
 * JARVIS Gmail Harness — read-only operations (list recent, search, read a
 * message) against the user's own connected Gmail account. Requires a
 * GoogleAccountConnector login first (see google-account-connector.js); a
 * not-connected account is never a dead end, it returns a spoken prompt to
 * connect in Settings, same as SpotifyHarness's not-connected fallback.
 * Client ID/Secret are passed into every call rather than stored here,
 * mirroring SpotifyHarness — this harness holds no credentials itself.
 */

export class GmailHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.gmail;
  }

  _notConnected() {
    return { success: false, message: "Your Google account isn't connected yet. Connect it in Settings, Sir." };
  }

  _summarizeList(messages) {
    if (!messages.length) return 'Your inbox has no recent messages, Sir.';
    const top = messages[0];
    return `You have ${messages.length} recent email${messages.length === 1 ? '' : 's'}. The most recent is from ${top.from}: "${top.subject}".`;
  }

  _summarizeSearch(messages, query) {
    if (!messages.length) return `I didn't find any emails matching "${query}", Sir.`;
    const top = messages[0];
    return `I found ${messages.length} email${messages.length === 1 ? '' : 's'} matching "${query}". The top result is from ${top.from}: "${top.subject}".`;
  }

  /**
   * Lists the most recent messages in the inbox.
   */
  async listRecent(clientId, clientSecret, maxResults = 10) {
    if (!this._isElectron()) return this._notConnected();
    try {
      const messages = await window.jarvisElectron.gmail.listMessages(clientId, clientSecret, maxResults);
      this.onLog({ type: 'SUCCESS', message: `[GMAIL] Listed ${messages.length} recent message(s).` });
      return { success: true, messages, message: this._summarizeList(messages) };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[GMAIL] listRecent failed: ${err.message}` });
      return { success: false, message: "I wasn't able to check your email, Sir." };
    }
  }

  /**
   * Full-text searches the mailbox (Gmail's own server-side search, same
   * syntax as the Gmail search bar).
   */
  async search(clientId, clientSecret, query, maxResults = 10) {
    if (!this._isElectron()) return this._notConnected();
    try {
      const messages = await window.jarvisElectron.gmail.search(clientId, clientSecret, query, maxResults);
      this.onLog({ type: 'SUCCESS', message: `[GMAIL] Search "${query}" -> ${messages.length} result(s).` });
      return { success: true, messages, message: this._summarizeSearch(messages, query) };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[GMAIL] search failed: ${err.message}` });
      return { success: false, message: "I wasn't able to search your email, Sir." };
    }
  }

  /**
   * Fetches one full message (headers + decoded plain-text body) by ID.
   */
  async getMessage(clientId, clientSecret, id) {
    if (!this._isElectron()) return this._notConnected();
    try {
      const msg = await window.jarvisElectron.gmail.getMessage(clientId, clientSecret, id);
      if (!msg) return { success: false, message: "I couldn't open that email, Sir." };
      return { success: true, ...msg, message: `From ${msg.from}, subject "${msg.subject}": ${msg.body}` };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[GMAIL] getMessage failed: ${err.message}` });
      return { success: false, message: "I wasn't able to open that email, Sir." };
    }
  }

  /**
   * Resolves a natural-language query ("the email from Sarah", "the invoice
   * from accounting") to a specific message and reads it. Gmail's search API
   * is already a real full-text/sender search, so — unlike SpotifyHarness's
   * local list + fuzzy-match — the top search hit is the resolution; no
   * separate matching step is needed.
   */
  async readMessage(clientId, clientSecret, query) {
    const searchResult = await this.search(clientId, clientSecret, query, 1);
    if (!searchResult.success || !searchResult.messages.length) {
      return { success: false, message: `I couldn't find an email matching "${query}", Sir.` };
    }
    return this.getMessage(clientId, clientSecret, searchResult.messages[0].id);
  }
}
