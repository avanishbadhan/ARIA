# Google Calendar Harness Design

**Status:** Approved
**Date:** 2026-08-15

## Summary

Extend JARVIS's existing Google integration (built for Gmail) to also cover Google Calendar: list upcoming events, search events, and create new events by voice or text. Reuses the existing `GoogleAccountConnector` OAuth connector unchanged — same "Connect Google Account" flow, same client ID/secret, one incremental scope grant.

## Architecture

```
GoogleAccountConnector (unchanged)
        |
        v
GoogleCalendarHarness (new, mirrors GmailHarness)
        |
        v
window.jarvisElectron.calendar.* (new preload bridge)
        |
        v
electron/main.cjs: calendar:list-events / calendar:search-events / calendar:create-event
        |
        v
Google Calendar API v3 (primary calendar)
```

`GoogleCalendarHarness` holds no credentials — client ID/secret are passed into every call, same as `GmailHarness` and `SpotifyHarness`. It requires the same `GoogleAccountConnector` login as Gmail; there is no separate "connect Calendar" step.

## OAuth Scope Change

Current scope (`main.cjs`): `https://www.googleapis.com/auth/gmail.readonly openid email profile`

New scope: adds `https://www.googleapis.com/auth/calendar.events` — grants read + write access to events on calendars the user can access, without granting access to calendar list/settings management. This is the minimal scope that covers both listing/searching events (read) and creating them (write).

**Consequence:** because this is an incremental scope, any account already connected under the old scope set has a refresh token that does NOT carry Calendar access. `authStatus()` will still report `authenticated: true` (the token is valid), but a Calendar API call will fail with an insufficient-scope error from Google. There is no special detection/messaging built for this — it falls into the harness's existing generic error handling (see Error Handling below). The fix is a one-time disconnect + reconnect in Settings, which will be documented in the README as a required step after this ships.

## Operations

### `listUpcoming(clientId, clientSecret, maxResults = 10)`
Lists events on the primary calendar starting from now, ordered by start time, with recurring events expanded to individual instances (`singleEvents=true`, `orderBy=startTime`, `timeMin=<now ISO>`).

Spoken summary:
- Empty: `"You have no upcoming events, Sir."`
- Non-empty: `"You have N upcoming event(s). The next is 'X' at [formatted time]."`

### `search(clientId, clientSecret, query, maxResults = 10)`
Calendar API's own text search (`q=` query param on the events.list endpoint) — same "the server already does full-text search, no local matching needed" pattern as `GmailHarness.search`.

Spoken summary:
- No match: `"I didn't find any events matching "query", Sir."`
- Match: `"I found N event(s) matching "query". The top result is 'X' at [formatted time]."`

### `createEvent(clientId, clientSecret, title, whenText, durationMinutes = 60, description = '')`
1. Parses `whenText` (a raw natural-language phrase like `"tomorrow at 3pm"` or `"next Friday at noon"`) into a start `Date` using `chrono-node`'s `chrono.parseDate(whenText, new Date())`.
2. If parsing fails (returns `null`), returns `{ success: false, message: "I couldn't figure out when to schedule that, Sir." }` without calling the API.
3. Computes `end = start + durationMinutes minutes`.
4. Calls the Electron bridge with `{ title, description, startISO: start.toISOString(), endISO: end.toISOString() }`.
5. Spoken confirmation: `"I've scheduled 'X' for [formatted start time], Sir."`

All NLP date resolution happens in the harness (renderer process, via `chrono-node`). `main.cjs` never receives or parses natural language — only ISO timestamps — keeping the "who's responsible for what" boundary identical to how `GmailHarness.readMessage` owns its own search→get resolution instead of pushing that logic into `main.cjs`.

## Electron Main Process Changes (`main.cjs`)

- `GOOGLE_AUTH_SCOPES` extended as described above.
- New pure functions, added near the existing Gmail helpers, reusing `getValidGoogleAccessToken` for token refresh and `gmailApiGet` for authenticated GETs (the function is generic enough despite its name — not renamed, to avoid an unrelated refactor):
  - `listCalendarEvents(accessToken, { q, maxResults } = {})` — GET `https://www.googleapis.com/calendar/v3/calendars/primary/events` with `timeMin`, `singleEvents=true`, `orderBy=startTime`, optional `q`, `maxResults`. Maps each raw event to `{ id, title, start, end, description }` (`start`/`end` pulled from `event.start.dateTime || event.start.date`).
  - `googleApiPost(url, accessToken, bodyObj)` — new generic authenticated POST helper (mirrors `gmailApiGet`'s shape, but POSTs a JSON body and expects a 200 response).
  - `createCalendarEvent(accessToken, { title, description, startISO, endISO })` — POST to `https://www.googleapis.com/calendar/v3/calendars/primary/events` with `{ summary: title, description, start: { dateTime: startISO }, end: { dateTime: endISO } }`. Returns `{ id, title, start, end }` from the response.
- New IPC handlers registered inside the existing `registerGoogleAuthIpc()`:
  - `calendar:list-events` — `{ clientId, clientSecret, maxResults }` → `listCalendarEvents`
  - `calendar:search-events` — `{ clientId, clientSecret, query, maxResults }` → `listCalendarEvents` with `q`
  - `calendar:create-event` — `{ clientId, clientSecret, title, description, startISO, endISO }` → `createCalendarEvent`
  - All three throw `'Not connected to Google. Please connect your account first.'` when `getValidGoogleAccessToken` returns null, identical to the Gmail handlers.

## Preload Bridge (`preload.cjs`)

```js
calendar: {
  listEvents: (clientId, clientSecret, maxResults) => ipcRenderer.invoke('calendar:list-events', { clientId, clientSecret, maxResults }),
  search: (clientId, clientSecret, query, maxResults) => ipcRenderer.invoke('calendar:search-events', { clientId, clientSecret, query, maxResults }),
  createEvent: (clientId, clientSecret, title, description, startISO, endISO) => ipcRenderer.invoke('calendar:create-event', { clientId, clientSecret, title, description, startISO, endISO })
}
```

## Tool-Calling Hookup

**Grounding tools** (autonomous LLM mid-conversation calls, read-only — added to `GROUNDING_TOOLS` in `jarvis-tools.js`):
- `list_upcoming_events` (no params)
- `search_calendar_events` (`{ query }`)

`create_event` is deliberately **not** a grounding tool — it's state-changing, same rule that excludes Gmail send/draft. It's only reachable via explicit intent.

**Explicit intents** (`ai-intent-classifier.js` + `autonomous-tool-reasoner.js` regex fallback + `jarvis-core.js` dispatch, mirroring the three Gmail dispatch blocks):
- `CALENDAR_LIST_UPCOMING` — no required params. Regex: phrases like `"what's on my calendar"`, `"any meetings today"`, `"check my calendar"`.
- `CALENDAR_SEARCH` — requires `query`. Regex: `"search my calendar for X"`, `"find the meeting about X"`.
- `CALENDAR_CREATE_EVENT` — requires `title` and `when`. Regex: `"schedule a meeting called X at/on Y"`, `"add an event called X for Y"`. The classifier/regex only extracts the raw title and when-phrase; the harness owns turning `when` into an actual timestamp (see Operations above).

## Data Flow (create event example)

```
User: "schedule a meeting called Standup for tomorrow at 9am"
  -> autonomous-tool-reasoner / AI classifier extracts
     { toolName: 'CALENDAR_CREATE_EVENT', params: { title: 'Standup', when: 'tomorrow at 9am' } }
  -> jarvis-core.js dispatch calls
     calendarHarness.createEvent(clientId, clientSecret, 'Standup', 'tomorrow at 9am')
  -> harness parses 'tomorrow at 9am' via chrono-node -> ISO start/end
  -> window.jarvisElectron.calendar.createEvent(...) -> IPC -> main.cjs
  -> main.cjs POSTs to Calendar API, returns created event
  -> harness returns { success: true, message: "I've scheduled 'Standup' for tomorrow at 9:00 AM, Sir." }
  -> spoken aloud, pushed to conversation history
```

## Security

- No new credential storage — reuses the existing encrypted (Electron `safeStorage`) Google token store.
- `calendar.events` scope is the narrowest scope that supports read + create; it does not grant access to other users' calendars, calendar sharing settings, or calendar deletion.
- `create_event` stays out of the autonomous grounding-tool list, same as every other state-changing action in this codebase (Spotify playback control, Gmail send/draft when it ships).

## Error Handling

Matches `GmailHarness`'s depth exactly — no new categories of error handling:
- Not connected to Electron / no `calendar` bridge → same `_notConnected()` fallback message as Gmail (*"Your Google account isn't connected yet. Connect it in Settings, Sir."*).
- Any API/network error (including a scope-mismatch 403 from a not-yet-reconnected account) → generic catch-all → spoken fallback (*"I wasn't able to check your calendar, Sir."* / *"...search your calendar..."* / *"...schedule that..."*), logged via `onLog` at `WARNING` level with the real error message for debugging.
- Unparseable `whenText` in `createEvent` → handled explicitly before any API call, per Operations above.

## Testing

- `jarvis/test/google-calendar-harness.test.js` — unit tests for `listUpcoming`/`search`/`createEvent`, mocking `window.jarvisElectron.calendar`, mirroring `gmail-harness.test.js`'s structure (not-connected fallback, success summaries, empty-result summaries, API-error fallback, unparseable-date fallback).
- `jarvis/test/jarvis-tools.test.js` — extend for `list_upcoming_events` / `search_calendar_events` grounding tool delegation + fallback, mirroring the existing Gmail grounding tool tests.
- `jarvis/test/ai-intent-classifier.test.js` — extend for `CALENDAR_LIST_UPCOMING` / `CALENDAR_SEARCH` / `CALENDAR_CREATE_EVENT` accept/reject cases.
- New `jarvis/test/autonomous-tool-reasoner.calendar-detection.test.js` — regex detection tests, mirroring the Gmail detection test file.
- `jarvis/test/jarvis-core.calendar-routing.test.js` — new, mirroring `jarvis-core.gmail-routing.test.js`: routing for all three intents, failure-result-still-spoken, non-calendar-query-never-calls-harness, constructor wiring.
- `main.cjs` changes verified via `node --check` only (no existing test coverage for that file, consistent with the Gmail work).
- Full suite (`npm test`) run at the end with zero regressions, matching the Gmail plan's checkpoint discipline.

## Out of Scope

- Editing or deleting existing events.
- Multiple/non-primary calendars.
- Event attendees/invites (would require sending on the user's behalf — separate concern).
- Recurring event creation (only creating single events; reading already-expanded recurring instances is in scope via `singleEvents=true`).
