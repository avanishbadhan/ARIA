# Nearby Places & Directions — Design Spec

Date: 2026-08-16
Status: Approved (brainstorming), pending implementation plan

## Problem

JARVIS already has `LocationHarness` (device geolocation) and uses it as a
`get_location` grounding tool, but nothing consumes location data to actually
answer "what's nearby" or "how do I get there." Two voice/text commands don't
work today:

- "find pizza near me" / "what's a good coffee shop around here"
- "directions to the airport" / "how do I get to X"

Both currently fall through to `GOOGLE_SEARCH`/`CONVERSATIONAL` and get a
generic web-search-flavored answer with no real place data or route.

## Decisions

- **Data source: free/keyless OSM stack**, not Google Maps Platform APIs.
  Google Maps Platform requires a billing account with a credit card on file
  to issue an API key at all, even though usage would likely stay within the
  free monthly credit for personal use — that setup friction was rejected.
  Using instead:
  - **Nominatim** — geocoding (place name/address → lat/lon)
  - **Overpass API** — nearby-place search (OpenStreetMap tag queries)
  - **OSRM** (public demo server) — driving route distance/duration
- **Map tabs still link to Google Maps.** Opening a `google.com/maps/...`
  URL in a browser tab is free and requires no API key — only *programmatic*
  API calls are billed/gated. So the spoken data comes from OSM, but the
  visual map tab that opens uses Google Maps for its more familiar UI and
  phone hand-off.
- **Routing: grounding tools, not dedicated intents.** `find_nearby_places`
  and `get_directions` are added to the existing `GROUNDING_TOOLS` list
  (`jarvis-tools.js`), exactly like `get_weather`/`get_location`. No changes
  to `autonomous-tool-reasoner.js` or `ai-intent-classifier.js`'s toolName
  dispatch — these are grounded-answer queries (like weather), not stateful
  actions (like opening a camera), and the existing `GOOGLE_SEARCH` /
  `CONVERSATIONAL` catch-all already receives this phrasing today. The
  "own knowledge" prompt in `jarvis-core.js` (~line 613) already says "if
  the question depends on where the user is... call get_location first" —
  this feature was anticipated but never finished.
- **Directions: driving mode only for v1.** No walking/transit support yet.
- **Directions: summary only, spoken.** "It's 4.2 miles, about 12 minutes by
  car." Full turn-by-turn stays on the map tab, not read aloud.
- **Nearby places: name + distance + address, spoken**, plus a map tab.

## Architecture

### New: `jarvis/src/maps-harness.js` — `MapsHarness`

Mirrors `WeatherHarness`'s shape: renderer-side class, Electron-only (no
CORS-safe browser fallback — dev-browser mode gets the same "not available
outside the desktop app" degradation weather uses).

```js
class MapsHarness {
  constructor(options = {}) { this.onLog = options.onLog || (() => {}); }

  _isElectron() { /* same check as WeatherHarness */ }

  async findNearbyPlaces(lat, lon, query) {
    // -> window.jarvisElectron.maps.findNearby(lat, lon, query)
    // returns { success: true, places: [{ name, distanceMi, address }, ...] }
    //      or { success: false, message }
  }

  async getDirections(lat, lon, destinationQuery) {
    // -> window.jarvisElectron.maps.getDirections(lat, lon, destinationQuery)
    // returns { success: true, distanceMi, durationMin, destinationLabel }
    //      or { success: false, message }
  }
}
```

### New Electron IPC: `registerMapsIpc()` in `electron/main.cjs`

Same "plain Node `https` in the main process" trick as `registerWeatherIpc`/
`registerWolframIpc` — keeps the pattern consistent even though there's no
API key to protect here, and avoids renderer CORS issues with the OSM
services.

- `maps:find-nearby` `(lat, lon, query)`:
  1. Build an Overpass QL query: bounding box ~2km around `(lat, lon)`,
     filtered by a small keyword→OSM-tag map (e.g. "pizza"/"coffee"/"gas" →
     `amenity=*`/`shop=*` values), falling back to a generic
     name-substring match for anything not in the map.
  2. POST to `https://overpass-api.de/api/interpreter`.
  3. Compute straight-line distance from `(lat, lon)` to each result
     (haversine), sort ascending, take top 5.
  4. Return `{ places: [...] }`.
- `maps:get-directions` `(lat, lon, destinationQuery)`:
  1. GET Nominatim `search?q=<destinationQuery>&viewbox=<bias around lat,lon>`
     for the top geocode match.
  2. If no match: return failure.
  3. GET OSRM `route/v1/driving/<lon>,<lat>;<destLon>,<destLat>?overview=false`.
  4. Return `{ distanceMi, durationMin, destinationLabel }` from the route.

### New Electron preload bridge (`preload.cjs`)

```js
maps: {
  findNearby: (lat, lon, query) => ipcRenderer.invoke('maps:find-nearby', { lat, lon, query }),
  getDirections: (lat, lon, destinationQuery) => ipcRenderer.invoke('maps:get-directions', { lat, lon, destinationQuery })
}
```

### Modified: `jarvis/src/jarvis-tools.js`

Two new entries in `GROUNDING_TOOLS`:

- `find_nearby_places({ query: string })` — description tells the LLM to
  call `get_location` first if it doesn't already have coordinates in
  context.
- `get_directions({ destination: string })` — same "call get_location
  first" guidance.

Two new branches in `createToolExecutor`, taking a new `maps` dependency,
following the exact `get_weather`/`get_location` shape: try the harness
call, log a `[TOOL CALL]` line, map success/failure to a plain-English
result string, never throw.

### Modified: `jarvis/src/jarvis-core.js`

- Instantiate `this.mapsHarness = new MapsHarness({ onLog: this.onLog })`
  next to `this.locationHarness` / `this.weatherHarness`.
- Pass `maps: this.mapsHarness` into `createToolExecutor(...)`.
- Add a `placesOrDirectionsNudge` regex alongside the existing
  `weatherNudge` (`jarvis-core.js:638`), matching phrases like
  `near me|nearby|around here|close by|directions to|how do i get to|
  navigate to|route to`, and append equivalent forcing language: "you MUST
  call get_location, then find_nearby_places or get_directions as
  appropriate — do NOT guess an address or business from memory."
- Same nudge also needs to be added to the "own knowledge" (high/ultra
  tier) prompt path (`jarvis-core.js:613`), which already has forward-
  looking language for this case but no tools to actually call yet.

### Modified: `jarvis/src/harness.js` (`BrowserHarness`)

Two new methods, both reusing the existing `window.open(...)` +
`tabsOpened`/`onViewportUpdate` bookkeeping already in `openWebsite`:

- `openNearbyTab(lat, lon, query)` → opens
  `https://www.google.com/maps/search/<query>/@<lat>,<lon>,15z`
- `openDirectionsTab(lat, lon, destinationQuery)` → opens
  `https://www.google.com/maps/dir/?api=1&origin=<lat>,<lon>&destination=<destinationQuery>&travelmode=driving`

Called from the grounding-tool executor after a successful
`find_nearby_places`/`get_directions` result (not on failure — nothing
useful to show).

## Data Flow

**"Find pizza near me":**
1. Classifier routes to `GOOGLE_SEARCH`/`CONVERSATIONAL` (unchanged).
2. `placesOrDirectionsNudge` fires → LLM calls `get_location`, then
   `find_nearby_places({ query: "pizza" })`.
3. `MapsHarness.findNearbyPlaces` → IPC → Overpass query → top 5 by
   distance.
4. Tool result string: up to 5 `"Name — 0.3mi, 123 Main St"` lines.
5. LLM speaks a natural-language summary of the top few results.
6. `harness.openNearbyTab(lat, lon, "pizza")` opens a Google Maps tab.

**"Directions to the airport":**
1. Classifier routes to `GOOGLE_SEARCH`/`CONVERSATIONAL` (unchanged).
2. Nudge fires → LLM calls `get_location`, then
   `get_directions({ destination: "the airport" })`.
3. `MapsHarness.getDirections` → IPC → Nominatim geocode → OSRM route.
4. Tool result string: `"4.2 miles, about 12 minutes by car."`
5. LLM speaks that summary.
6. `harness.openDirectionsTab(lat, lon, "the airport")` opens the Google
   Maps directions tab for full turn-by-turn.

## Error Handling

Every failure mode resolves to a spoken-safe string; nothing throws up to
the LLM/voice layer. Mirrors `WeatherHarness`/`get_weather` conventions.

| Failure | Behavior |
|---|---|
| Geolocation denied/unavailable | Existing `get_location` failure message; places/directions call never attempted. |
| Nominatim finds no destination match | `get_directions` returns "I couldn't find that place, Sir."; no tab opens. |
| Overpass returns zero results in radius | `find_nearby_places` returns "I couldn't find anything nearby, Sir."; no tab opens. |
| OSRM/Overpass/Nominatim network failure or non-2xx | IPC handler rejects; harness method resolves `{ success: false, message: "I wasn't able to reach the map service, Sir." }`. |
| Dev-browser (non-Electron) mode | Both methods short-circuit to "not available outside the desktop app," same as weather — no fetch attempted. |

**Note on public server usage policies:** Overpass, Nominatim, and OSRM's
public demo servers are free but rate-limited and intended for light,
non-bulk use. Fine for a single personal-assistant user; would need a
self-hosted or paid instance if usage ever scaled up. Worth a one-line
comment in `maps-harness.js` noting this.

## Testing

- `jarvis/test/maps-harness.test.js` — new, mirrors
  `jarvis/test/weather-harness.test.js`: mocked
  `window.jarvisElectron.maps.*` bridge, success/failure/non-Electron
  cases for both methods.
- `jarvis/test/jarvis-tools.test.js` — add `find_nearby_places` and
  `get_directions` executor cases, mirroring the existing `get_weather`
  tests (success, harness-missing, harness-failure).
- `jarvis/test/jarvis-core.*.test.js` — a routing test confirming the new
  nudge regex fires for representative phrasings ("pizza near me",
  "directions to the airport") and that the maps tools are present in
  `this.groundingTools`/wired into `this.toolExecutor`.

## Out of Scope (v1)

- Walking/transit/cycling directions.
- Turn-by-turn spoken navigation.
- Ratings, "open now" status, photos (not available from free OSM data
  without extra paid/keyed services).
- Multi-stop routes.
- A Google Maps Platform migration path (if OSM data quality turns out to
  be insufficient later, this is a follow-up spec, not part of this one).
