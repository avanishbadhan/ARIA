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
// The exact sentinel BrowserHarness.fetchLiveSearchAnswer() falls back to —
// written for its tab-opening caller (executeGoogleSearch). This tool never
// opens a tab, so that sentinel would be misleading if handed to the model.
const HARNESS_NO_RESULT_PREFIX = 'I have launched a Google search for';
const NO_EMAIL_RESULT = 'Gmail is not connected or no matching emails were found.';

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
  }
];

/**
 * Returns an async (name, argsJson) => resultString dispatcher. Never
 * throws — a tool failure resolves to a "no result" string so the calling
 * model can still answer from its own knowledge instead of the whole
 * completion failing.
 */
export function createToolExecutor({ wolfram, harness, gmail, getGoogleCredentials, onLog = () => {} }) {
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
        const answer = harness ? await harness.fetchLiveSearchAnswer(query) : null;
        const usable = answer && !answer.startsWith(HARNESS_NO_RESULT_PREFIX) ? answer : NO_SEARCH_RESULT;
        onLog({ type: 'TOOL', message: `[TOOL CALL] web_search("${query}") -> ${usable === NO_SEARCH_RESULT ? 'no result' : `"${usable}"`}` });
        return usable;
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

    onLog({ type: 'WARNING', message: `[TOOL CALL] Unknown tool requested: ${name}` });
    return `Unknown tool: ${name}`;
  };
}
