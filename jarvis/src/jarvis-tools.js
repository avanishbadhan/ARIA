/**
 * Read-only "grounding" tools exposed to autonomous LLM function-calling —
 * deliberately just fetch/compute and hand back a result, nothing that
 * launches apps, plays media, or changes system state (those stay on the
 * existing pre-classified dispatch path in jarvis-core.js's
 * processUserInput, never handed to a model to trigger on its own
 * initiative). Provider-agnostic on purpose: any OpenAI-compatible client
 * (Groq, OpenRouter, and eventually a Gemini/Google connector) can pass this
 * same schema+executor pair to fetchChatCompletion.
 */

const NO_SEARCH_RESULT = 'No web search result found for this query.';
const NO_EMAIL_RESULT = 'Gmail is not connected or no matching emails were found.';
const NO_CALENDAR_RESULT = 'Google Calendar is not connected or no matching events were found.';
const NO_WEBPAGE_RESULT = 'Unable to read that webpage.';
const NO_WEATHER_RESULT = 'Unable to retrieve live weather data.';

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
  }
];

/**
 * Returns an async (name, argsJson) => resultString dispatcher. Never
 * throws — a tool failure resolves to a "no result" string so the calling
 * model can still answer from its own knowledge instead of the whole
 * completion failing.
 */
export function createToolExecutor({ wolfram, harness, gmail, calendar, location, weather, mcpWeb, getGoogleCredentials, onLog = () => {} }) {
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

    onLog({ type: 'WARNING', message: `[TOOL CALL] Unknown tool requested: ${name}` });
    return `Unknown tool: ${name}`;
  };
}
