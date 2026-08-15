/**
 * JARVIS Google Calendar Harness — list upcoming events, search events, and
 * create single events against the user's connected Google Calendar. Requires
 * a GoogleAccountConnector login first (see google-account-connector.js); the
 * same account as Gmail, there is no separate "connect Calendar" step. A
 * not-connected account is never a dead end, it returns a spoken prompt to
 * connect in Settings, same as GmailHarness's not-connected fallback.
 * Client ID/Secret are passed into every call rather than stored here,
 * mirroring GmailHarness — this harness holds no credentials itself.
 *
 * All natural-language date resolution for event creation happens here (via
 * chrono-node) in the renderer; the Electron main process only ever receives
 * ISO timestamps, keeping the "who's responsible for what" boundary identical
 * to how GmailHarness.readMessage owns its own search->get resolution.
 */

import * as chrono from 'chrono-node';

export class GoogleCalendarHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.calendar;
  }

  _notConnected() {
    return { success: false, message: "Your Google account isn't connected yet. Connect it in Settings, Sir." };
  }

  _formatTime(date) {
    return date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  _summarizeList(events) {
    if (!events.length) return 'You have no upcoming events, Sir.';
    const top = events[0];
    return `You have ${events.length} upcoming event${events.length === 1 ? '' : 's'}. The next is '${top.title}' at ${this._formatTime(new Date(top.start))}.`;
  }

  _summarizeSearch(events, query) {
    if (!events.length) return `I didn't find any events matching "${query}", Sir.`;
    const top = events[0];
    return `I found ${events.length} event${events.length === 1 ? '' : 's'} matching "${query}". The top result is '${top.title}' at ${this._formatTime(new Date(top.start))}.`;
  }

  /**
   * Lists upcoming events on the primary calendar starting from now, ordered
   * by start time (recurring events expanded to individual instances).
   */
  async listUpcoming(clientId, clientSecret, maxResults = 10) {
    if (!this._isElectron()) return this._notConnected();
    try {
      const events = await window.jarvisElectron.calendar.listEvents(clientId, clientSecret, maxResults);
      this.onLog({ type: 'SUCCESS', message: `[CALENDAR] Listed ${events.length} upcoming event(s).` });
      return { success: true, events, message: this._summarizeList(events) };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[CALENDAR] listUpcoming failed: ${err.message}` });
      return { success: false, message: "I wasn't able to check your calendar, Sir." };
    }
  }

  /**
   * Full-text searches the calendar (Calendar API's own server-side search,
   * same `q=` query-param pattern as GmailHarness.search — no local matching
   * needed).
   */
  async search(clientId, clientSecret, query, maxResults = 10) {
    if (!this._isElectron()) return this._notConnected();
    try {
      const events = await window.jarvisElectron.calendar.search(clientId, clientSecret, query, maxResults);
      this.onLog({ type: 'SUCCESS', message: `[CALENDAR] Search "${query}" -> ${events.length} result(s).` });
      return { success: true, events, message: this._summarizeSearch(events, query) };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[CALENDAR] search failed: ${err.message}` });
      return { success: false, message: "I wasn't able to search your calendar, Sir." };
    }
  }

  /**
   * Creates a single event on the primary calendar. `whenText` is a raw
   * natural-language phrase ("tomorrow at 3pm", "next Friday at noon") parsed
   * here into a start time via chrono-node; an unparseable phrase returns a
   * spoken fallback without ever calling the API.
   */
  async createEvent(clientId, clientSecret, title, whenText, durationMinutes = 60, description = '') {
    if (!this._isElectron()) return this._notConnected();

    const start = chrono.parseDate(whenText, new Date());
    if (!start) {
      return { success: false, message: "I couldn't figure out when to schedule that, Sir." };
    }

    const end = new Date(start.getTime() + durationMinutes * 60000);

    try {
      const event = await window.jarvisElectron.calendar.createEvent(clientId, clientSecret, title, description, start.toISOString(), end.toISOString());
      this.onLog({ type: 'SUCCESS', message: `[CALENDAR] Created event "${title}".` });
      return { success: true, event, message: `I've scheduled '${title}' for ${this._formatTime(start)}, Sir.` };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[CALENDAR] createEvent failed: ${err.message}` });
      return { success: false, message: "I wasn't able to schedule that, Sir." };
    }
  }
}
