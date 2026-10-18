/**
 * Grounding tools exposed to autonomous LLM function-calling. Almost all of
 * them are read-only — they just fetch/compute and hand back a result,
 * nothing that launches apps, plays media, or changes system state (those
 * stay on the existing pre-classified dispatch path in jarvis-core.js's
 * processUserInput, never handed to a model to trigger on its own
 * initiative).
 *
 * Deliberate narrow exception: the notes tools (write_note / read_note /
 * list_notes / delete_note) are state-changing, but confined entirely to an
 * isolated sandbox directory (app.getPath('userData')/jarvis-notes/) and
 * reversible — nothing launches and nothing leaves the sandbox. Overwrites
 * and deletes still require a spoken-confirmation round trip via
 * setPendingFileAction (they never fire directly from a model call); fresh
 * writes and reads execute immediately like the other tools. See
 * docs/superpowers/specs/2026-08-19-jarvis-notes-filesystem-design.md.
 *
 * Provider-agnostic on purpose: any OpenAI-compatible client (Groq,
 * OpenRouter, and eventually a Gemini/Google connector) can pass this
 * same schema+executor pair to fetchChatCompletion.
 */

const NO_SEARCH_RESULT = 'No web search result found for this query.';
const NO_EMAIL_RESULT = 'Gmail is not connected or no matching emails were found.';
const NO_CALENDAR_RESULT = 'Google Calendar is not connected or no matching events were found.';
const NO_WEBPAGE_RESULT = 'Unable to read that webpage.';
const NO_WEATHER_RESULT = 'Unable to retrieve live weather data.';
const NO_NEARBY_RESULT = "I couldn't find anything nearby, Sir.";
const NO_DIRECTIONS_RESULT = "I couldn't find that place, Sir.";
const NO_NOTE_STORAGE = "File storage isn't available outside the ARIA desktop app, Sir.";
const NO_NOTE_WRITE_RESULT = "I wasn't able to save that note, Sir.";
const NO_NOTE_READ_RESULT = "I wasn't able to read that note, Sir.";
const NO_NOTE_LIST_RESULT = "I wasn't able to list your notes, Sir.";

export const GROUNDING_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'solve_math',
      description: "Solves a math expression or word problem using WolframAlpha's computational engine. Use this whenever you need to compute an exact numeric or symbolic result instead of calculating it yourself.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The math expression or question, in plain English or standard notation (e.g. "integral of x^2", "15% of 340").' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Looks up a live, current fact on the web. Use this for anything that could have changed since your training data or that you are not confident about.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_recent_emails',
      description: "Lists the user's most recent Gmail messages (sender, subject, snippet). Use this when the user asks about recent email or their inbox without a specific search term.",
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_emails',
      description: "Searches the user's Gmail for messages matching a query (sender name, subject keywords, or content). Use this to answer questions about a specific email or sender.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms — sender, subject keywords, or content to match.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_upcoming_events',
      description: "Lists the user's upcoming Google Calendar events starting from now. Use this when the user asks what's on their calendar or about upcoming meetings without a specific search term.",
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_calendar_events',
      description: "Searches the user's Google Calendar for events matching a query (event title or description keywords). Use this to answer questions about a specific meeting or event.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms — event title or description keywords to match.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_location',
      description: "Returns the user's current geographic coordinates (latitude, longitude) via the device's location services. Use this whenever an answer depends on where the user physically is right now — e.g. what's nearby, weather here, distances, or directions. Read-only and one-shot; it does not track the user.",
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: "Returns the current weather conditions (temperature in Celsius, feels-like, humidity, wind, and a short description) at the given latitude/longitude via Open-Meteo. Use this to answer weather or temperature questions for a specific place. Coordinates are required — call get_location first if the user means 'here'.",
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude of the location to check.' },
          lon: { type: 'number', description: 'Longitude of the location to check.' }
        },
        required: ['lat', 'lon']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browse_webpage',
      description: "Reads the actual content of a specific webpage by URL. Use this when you already have a URL — e.g. from a prior web_search result or one the user mentioned — and want its real content, not just a search snippet.",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to read, including https://.' },
          linkText: { type: 'string', description: 'Optional — text to search for within the page (e.g. a link or heading), to focus the result on that section.' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_nearby_places',
      description: "Finds nearby places matching a category or keyword (e.g. pizza, coffee, gas) around a latitude/longitude, returning the closest few with name, straight-line distance in miles, and street address. Coordinates are required — call get_location first if the user means 'here'. Answer place requests with this tool's real results instead of guessing a business from memory.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The type of place to find (e.g. "pizza", "coffee shop", "gas station").' },
          lat: { type: 'number', description: 'Optional latitude. Omit to use the user\'s current location (call get_location first).' },
          lon: { type: 'number', description: 'Optional longitude. Omit to use the user\'s current location (call get_location first).' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_directions',
      description: "Gets driving directions from a latitude/longitude to a destination, returning the total distance in miles and estimated drive time. Coordinates are required — call get_location first if the user means 'here'. Answer directions requests with this tool's real route data instead of guessing a distance or time from memory.",
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: 'The destination, e.g. "the airport", "a coffee shop on Main St", or a place name.' },
          lat: { type: 'number', description: 'Optional origin latitude. Omit to use the user\'s current location (call get_location first).' },
          lon: { type: 'number', description: 'Optional origin longitude. Omit to use the user\'s current location (call get_location first).' }
        },
        required: ['destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_note',
      description: "Saves a short note as a .md file in ARIA's private notes sandbox (persistent memory across conversations). Use this when the user asks you to remember, save, or make a note of something. If the note already exists, a confirmation round trip is required before overwriting — do NOT rewrite it yourself; tell the user it already exists and ask whether to overwrite.",
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'A short, descriptive name for the note (no extension, e.g. "wifi-password").' },
          content: { type: 'string', description: 'The note content to save.' }
        },
        required: ['filename', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: "Reads the content of a saved note from ARIA's private notes sandbox by filename. Use this when the user asks what they saved about something or wants to recall a note. Call list_notes first if unsure of the exact filename.",
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'The name of the note to read (no extension).' }
        },
        required: ['filename']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_notes',
      description: "Lists all notes saved in ARIA's private notes sandbox, most recently modified first, each with a short preview and its modified time. Use this when the user asks what notes are saved or what you remember.",
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_note',
      description: "Deletes a saved note from ARIA's private notes sandbox by filename. Deletion requires a spoken confirmation round trip — call this and then ask the user to confirm before it is actually deleted.",
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'The name of the note to delete (no extension).' }
        },
        required: ['filename']
      }
    }
  }
];

/**
 * Returns an async (name, argsJson) => resultString dispatcher. Never
 * throws — a tool failure resolves to a "no result" string so the calling
 * model can still answer from its own knowledge instead of the whole
 * completion failing.
 */
export function createToolExecutor({ wolfram, harness, gmail, calendar, location, weather, maps, mcpWeb, getGoogleCredentials, files, setPendingFileAction, onLog = () => {} }) {
  return async function executeTool(name, argsJson) {
    let args;
    try {
      args = JSON.parse(argsJson || '{}');
    } catch (e) {
      onLog({ type: 'WARNING', message: `[TOOL CALL] ${name}: unparseable arguments "${argsJson}"` });
      return 'Invalid tool arguments.';
    }

    if (name === 'solve_math') {
      const query = args.query || '';
      try {
        const answer = wolfram ? await wolfram.solve(query) : null;
        onLog({ type: 'TOOL', message: `[TOOL CALL] solve_math("${query}") -> ${answer ? `"${answer}"` : 'no result'}` });
        return answer || 'WolframAlpha unavailable or found no result for this query.';
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] solve_math failed: ${e.message}` });
        return 'WolframAlpha unavailable or found no result for this query.';
      }
    }

    if (name === 'web_search') {
      const query = args.query || '';
      try {
        if (!mcpWeb) return NO_SEARCH_RESULT;
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const result = await mcpWeb.fetchWebpage(searchUrl);
        onLog({ type: 'TOOL', message: `[TOOL CALL] web_search("${query}") -> ${result.success ? 'result found' : 'no result'}` });
        return result.success ? result.text : NO_SEARCH_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] web_search failed: ${e.message}` });
        return NO_SEARCH_RESULT;
      }
    }

    if (name === 'list_recent_emails') {
      try {
        if (!gmail || !getGoogleCredentials) return NO_EMAIL_RESULT;
        const { clientId, clientSecret } = getGoogleCredentials();
        const result = await gmail.listRecent(clientId, clientSecret);
        onLog({ type: 'TOOL', message: `[TOOL CALL] list_recent_emails() -> ${result.success ? `${result.messages.length} message(s)` : 'unavailable'}` });
        return result.success ? result.message : NO_EMAIL_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] list_recent_emails failed: ${e.message}` });
        return NO_EMAIL_RESULT;
      }
    }

    if (name === 'search_emails') {
      const query = args.query || '';
      try {
        if (!gmail || !getGoogleCredentials) return NO_EMAIL_RESULT;
        const { clientId, clientSecret } = getGoogleCredentials();
        const result = await gmail.search(clientId, clientSecret, query);
        onLog({ type: 'TOOL', message: `[TOOL CALL] search_emails("${query}") -> ${result.success ? `${result.messages.length} result(s)` : 'unavailable'}` });
        return result.success ? result.message : NO_EMAIL_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] search_emails failed: ${e.message}` });
        return NO_EMAIL_RESULT;
      }
    }

    if (name === 'list_upcoming_events') {
      try {
        if (!calendar || !getGoogleCredentials) return NO_CALENDAR_RESULT;
        const { clientId, clientSecret } = getGoogleCredentials();
        const result = await calendar.listUpcoming(clientId, clientSecret);
        onLog({ type: 'TOOL', message: `[TOOL CALL] list_upcoming_events() -> ${result.success ? `${result.events.length} event(s)` : 'unavailable'}` });
        return result.success ? result.message : NO_CALENDAR_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] list_upcoming_events failed: ${e.message}` });
        return NO_CALENDAR_RESULT;
      }
    }

    if (name === 'search_calendar_events') {
      const query = args.query || '';
      try {
        if (!calendar || !getGoogleCredentials) return NO_CALENDAR_RESULT;
        const { clientId, clientSecret } = getGoogleCredentials();
        const result = await calendar.search(clientId, clientSecret, query);
        onLog({ type: 'TOOL', message: `[TOOL CALL] search_calendar_events("${query}") -> ${result.success ? `${result.events.length} result(s)` : 'unavailable'}` });
        return result.success ? result.message : NO_CALENDAR_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] search_calendar_events failed: ${e.message}` });
        return NO_CALENDAR_RESULT;
      }
    }

    if (name === 'get_location') {
      try {
        if (!location || typeof location.getCurrentPosition !== 'function') {
          return 'Location access is not available in this environment.';
        }
        const result = await location.getCurrentPosition();
        if (result.success) {
          const coords = `latitude ${result.lat.toFixed(5)}, longitude ${result.lon.toFixed(5)}`;
          onLog({ type: 'TOOL', message: `[TOOL CALL] get_location() -> ${coords}` });
          return `The user's current location is ${coords}.`;
        }
        return result.message || 'I was unable to determine the user\'s location.';
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] get_location failed: ${e.message}` });
        return 'I was unable to determine the user\'s location.';
      }
    }

    if (name === 'get_weather') {
      const lat = Number(args.lat);
      const lon = Number(args.lon);
      try {
        if (!weather || typeof weather.getCurrentWeather !== 'function' || Number.isNaN(lat) || Number.isNaN(lon)) {
          return NO_WEATHER_RESULT;
        }
        const result = await weather.getCurrentWeather(lat, lon);
        if (result.success) {
          const msg = `Current weather: ${result.temperatureC}°C (feels like ${result.feelsLikeC}°C), ${result.description}, humidity ${result.humidityPct}%, wind ${result.windKmph} km/h.`;
          onLog({ type: 'TOOL', message: `[TOOL CALL] get_weather(${lat}, ${lon}) -> ${result.temperatureC}°C` });
          return msg;
        }
        return NO_WEATHER_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] get_weather failed: ${e.message}` });
        return NO_WEATHER_RESULT;
      }
    }

    if (name === 'browse_webpage') {
      const url = args.url || '';
      const linkText = args.linkText;
      try {
        if (!mcpWeb) return NO_WEBPAGE_RESULT;
        const result = await mcpWeb.browseWebpage(url, linkText);
        onLog({ type: 'TOOL', message: `[TOOL CALL] browse_webpage("${url}") -> ${result.success ? 'result found' : 'no result'}` });
        return result.success ? result.text : NO_WEBPAGE_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] browse_webpage failed: ${e.message}` });
        return NO_WEBPAGE_RESULT;
      }
    }

    // Resolves coordinates for the maps tools: uses the passed lat/lon args
    // if the model supplied them, otherwise resolves the user's current
    // position via the location harness. Returns null if unavailable.
    async function resolveCoords(latArg, lonArg) {
      if (!Number.isNaN(Number(latArg)) && !Number.isNaN(Number(lonArg))) {
        return { lat: Number(latArg), lon: Number(lonArg) };
      }
      if (location && typeof location.getCurrentPosition === 'function') {
        const res = await location.getCurrentPosition();
        if (res.success) return { lat: res.lat, lon: res.lon };
      }
      return null;
    }

    if (name === 'find_nearby_places') {
      const query = args.query || '';
      try {
        if (!maps || typeof maps.findNearbyPlaces !== 'function') return NO_NEARBY_RESULT;
        const coords = await resolveCoords(args.lat, args.lon);
        if (!coords) return NO_NEARBY_RESULT;
        const result = await maps.findNearbyPlaces(coords.lat, coords.lon, query);
        if (result.success) {
          if (harness && typeof harness.openNearbyTab === 'function') {
            try { harness.openNearbyTab(coords.lat, coords.lon, query); } catch (e) {}
          }
          const lines = result.places.map((p) =>
            `${p.name}${p.distanceMi != null ? ` — ${p.distanceMi.toFixed(1)}mi` : ''}${p.address ? `, ${p.address}` : ''}`
          );
          onLog({ type: 'TOOL', message: `[TOOL CALL] find_nearby_places("${query}") -> ${result.places.length} place(s)` });
          return lines.length ? lines.join('\n') : NO_NEARBY_RESULT;
        }
        return result.message || NO_NEARBY_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] find_nearby_places failed: ${e.message}` });
        return NO_NEARBY_RESULT;
      }
    }

    if (name === 'get_directions') {
      const destination = args.destination || '';
      try {
        if (!maps || typeof maps.getDirections !== 'function') return NO_DIRECTIONS_RESULT;
        const coords = await resolveCoords(args.lat, args.lon);
        if (!coords) return NO_DIRECTIONS_RESULT;
        const result = await maps.getDirections(coords.lat, coords.lon, destination);
        if (result.success) {
          if (harness && typeof harness.openDirectionsTab === 'function') {
            try { harness.openDirectionsTab(coords.lat, coords.lon, destination); } catch (e) {}
          }
          onLog({ type: 'TOOL', message: `[TOOL CALL] get_directions("${destination}") -> ${result.distanceMi} mi, ~${result.durationMin} min` });
          return `It's ${result.distanceMi} miles, about ${result.durationMin} minutes by car.`;
        }
        return result.message || NO_DIRECTIONS_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] get_directions failed: ${e.message}` });
        return NO_DIRECTIONS_RESULT;
      }
    }

    if (name === 'write_note') {
      const filename = args.filename || '';
      const content = args.content || '';
      try {
        if (!files || typeof files.writeNote !== 'function') return NO_NOTE_STORAGE;
        const result = await files.writeNote(filename, content, false);
        if (result.success) {
          onLog({ type: 'TOOL', message: `[TOOL CALL] write_note("${result.filename}") -> saved` });
          return `Note saved as "${result.filename}".`;
        }
        if (result.exists) {
          const safeName = result.filename || filename;
          if (setPendingFileAction) {
            setPendingFileAction({
              type: 'overwrite',
              filename: safeName,
              content,
              expiresAt: Date.now() + 120000
            });
          }
          onLog({ type: 'TOOL', message: `[TOOL CALL] write_note("${safeName}") -> exists, confirmation pending` });
          return `A note named "${safeName}" already exists — ask the user to confirm before overwriting it.`;
        }
        return result.message || NO_NOTE_WRITE_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] write_note failed: ${e.message}` });
        return NO_NOTE_WRITE_RESULT;
      }
    }

    if (name === 'read_note') {
      const filename = args.filename || '';
      try {
        if (!files || typeof files.readNote !== 'function') return NO_NOTE_STORAGE;
        const result = await files.readNote(filename);
        if (result.success) {
          onLog({ type: 'TOOL', message: `[TOOL CALL] read_note("${filename}") -> read` });
          return result.content;
        }
        onLog({ type: 'TOOL', message: `[TOOL CALL] read_note("${filename}") -> not found` });
        return `${result.message || NO_NOTE_READ_RESULT} You could call list_notes to see what notes are saved.`;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] read_note failed: ${e.message}` });
        return NO_NOTE_READ_RESULT;
      }
    }

    if (name === 'list_notes') {
      try {
        if (!files || typeof files.listNotes !== 'function') return NO_NOTE_STORAGE;
        const result = await files.listNotes();
        if (result.success) {
          if (!result.files.length) return 'No notes saved yet.';
          const lines = result.files.map((f) =>
            `${f.filename} — ${f.preview || 'empty'} (modified ${new Date(f.modifiedAt).toLocaleString()})`
          );
          onLog({ type: 'TOOL', message: `[TOOL CALL] list_notes() -> ${result.files.length} note(s)` });
          return lines.join('\n');
        }
        return result.message || NO_NOTE_LIST_RESULT;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] list_notes failed: ${e.message}` });
        return NO_NOTE_LIST_RESULT;
      }
    }

    if (name === 'delete_note') {
      const filename = args.filename || '';
      try {
        if (!files || typeof files.deleteNote !== 'function') return NO_NOTE_STORAGE;
        if (setPendingFileAction) {
          setPendingFileAction({
            type: 'delete',
            filename,
            expiresAt: Date.now() + 120000
          });
        }
        onLog({ type: 'TOOL', message: `[TOOL CALL] delete_note("${filename}") -> confirmation pending` });
        return `Deleting "${filename}" requires confirmation — ask the user to confirm before it is deleted.`;
      } catch (e) {
        onLog({ type: 'WARNING', message: `[TOOL CALL] delete_note failed: ${e.message}` });
        return "I wasn't able to delete that note, Sir.";
      }
    }

    onLog({ type: 'WARNING', message: `[TOOL CALL] Unknown tool requested: ${name}` });
    return `Unknown tool: ${name}`;
  };
}
