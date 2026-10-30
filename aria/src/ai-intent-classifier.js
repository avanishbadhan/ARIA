/**
 * Runs the AI-first intent classification call and validates its response
 * before trusting it. Returns a decision object shaped exactly like
 * AutonomousToolReasoner.evaluateIntent()'s return value, or null if the AI
 * classifier is unavailable, errored, or returned something invalid — callers
 * (jarvis-core.js's processUserInput) fall back to the regex reasoner in that
 * case. Same "never invent, always validate" discipline as
 * llm-entity-resolver.js's resolveWithLlmFallback.
 */

const TOOL_PARAM_REQUIREMENTS = {
  GOOGLE_SEARCH: ['query'],
  STEAM_LAUNCH_GAME: ['gameQuery'],
  STEAM_OPEN_CLIENT: [],
  SPOTIFY_PLAY_SONG: ['query'],
  SPOTIFY_PLAY_LIBRARY: ['kind', 'query'],
  SPOTIFY_OPEN_CLIENT: [],
  EPIC_OPEN_CLIENT: [],
  EPIC_LAUNCH_GAME: ['gameQuery'],
  XBOX_OPEN_CLIENT: [],
  XBOX_LAUNCH_GAME: ['gameQuery'],
  OPEN_SITE: ['siteName'],
  MATH_QUERY: ['query'],
  SET_MODEL_TIER: ['tier'],
  SCREEN_MONITOR_START: [],
  SCREEN_MONITOR_STOP: [],
  SCREEN_TOGGLE_OVERLAY: [],
  SCREEN_QUERY: ['question'],
  CAMERA_START: [],
  CAMERA_STOP: [],
  CAMERA_QUERY: ['question'],
  GMAIL_CHECK_INBOX: [],
  GMAIL_SEARCH: ['query'],
  GMAIL_READ_MESSAGE: ['query'],
  CALENDAR_LIST_UPCOMING: [],
  CALENDAR_SEARCH: ['query'],
  CALENDAR_CREATE_EVENT: ['title', 'when'],
  CONVERSATIONAL: []
};

export const INTENT_CLASSIFIER_SYSTEM_PROMPT = `You are ARIA's intent classifier. Given the user's utterance, decide which
single tool (if any) should handle it, and return ONLY strict JSON — no
markdown, no prose — matching this exact shape:

{"shouldCallTool": true|false, "toolName": "<one of the list below>",
 "confidence": 0.0-1.0, "params": {...}, "reasoning": "short explanation"}

Available tools and their exact params shape:
- GOOGLE_SEARCH: { query: string }
- STEAM_LAUNCH_GAME: { gameQuery: string }
- STEAM_OPEN_CLIENT: {}
- SPOTIFY_PLAY_SONG: { query: string }
- SPOTIFY_PLAY_LIBRARY: { kind: "playlist"|"album"|"liked", query: string }
- SPOTIFY_OPEN_CLIENT: {}
- EPIC_OPEN_CLIENT: {}
- EPIC_LAUNCH_GAME: { gameQuery: string }
- XBOX_OPEN_CLIENT: {}
- XBOX_LAUNCH_GAME: { gameQuery: string }
- OPEN_SITE: { siteName: string } — ONLY when the user names a specific real site (e.g. "open YouTube", "go to github.com") or gives a full URL. Do NOT use OPEN_SITE for "open my browser", "open a new tab", "click on the first link", or vague browsing — those are GOOGLE_SEARCH or CONVERSATIONAL, not OPEN_SITE.
- MATH_QUERY: { query: string }
- SET_MODEL_TIER: { tier: "quick"|"medium"|"high"|"ultra" }
- SCREEN_MONITOR_START: {}
- SCREEN_MONITOR_STOP: {}
- SCREEN_TOGGLE_OVERLAY: {} — user wants to show, hide, or toggle the screen overlay panel (e.g. "show screen overlay", "hide overlay", "toggle overlay")
- SCREEN_QUERY: { question: string } — the user is asking about what is currently shown or being viewed on their computer screen/display or desktop (e.g. "what's on my screen", "what am I looking at", "what am I viewing on my computer", "what does this say", "can you read this error", "what is this code doing", "describe the chart on my screen", "what is this error"). A screenshot is captured and analyzed with a vision model. Do NOT use for general-knowledge or web questions with no reference to what the user is viewing (those are GOOGLE_SEARCH or CONVERSATIONAL).
- CAMERA_START: {} — user wants to open/activate/turn on the webcam or camera vision feed (e.g. "open camera", "turn on the camera")
- CAMERA_STOP: {} — user wants to close/deactivate/turn off the webcam or camera vision feed
- CAMERA_QUERY: { question: string } — user is asking a question about what the webcam currently sees (e.g. "what am I holding", "how many fingers am I holding up", "can you see me")
- GMAIL_CHECK_INBOX: {} — user wants to check their email/inbox generally
- GMAIL_SEARCH: { query: string } — user wants to search their email for something specific
- GMAIL_READ_MESSAGE: { query: string } — user wants ARIA to read a specific email (by sender or subject) aloud
- CALENDAR_LIST_UPCOMING: {} — user wants to know what's on their calendar / upcoming meetings generally
- CALENDAR_SEARCH: { query: string } — user wants to search their calendar for an event matching something specific
- CALENDAR_CREATE_EVENT: { title: string, when: string } — user wants to schedule a new event; title is the event name, when is a natural-language time phrase like "tomorrow at 3pm" that the harness resolves into a real timestamp
- CONVERSATIONAL: {} (default — no tool needed, just answer normally)

If the utterance may be a mis-transcribed version of one of the above
(garbled speech-to-text), still classify by best-guess intent rather than
defaulting to CONVERSATIONAL.`;

export async function classifyIntentWithAI({ input, classifyIntent, onLog = () => {} }) {
  if (!classifyIntent) return null;

  let raw;
  try {
    raw = await classifyIntent(input);
  } catch (e) {
    onLog({ type: 'WARNING', message: `[AI INTENT CLASSIFIER] ${e.message}` });
    return null;
  }

  if (!raw) return null; // no LLM provider available — silent, expected fallback path

  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    onLog({ type: 'WARNING', message: `[AI INTENT CLASSIFIER] Response was not valid JSON — falling back to regex. Raw: ${cleaned.slice(0, 200)}` });
    return null;
  }

  const { toolName } = parsed;
  if (!toolName || !(toolName in TOOL_PARAM_REQUIREMENTS)) {
    onLog({ type: 'WARNING', message: `[AI INTENT CLASSIFIER] Unrecognized toolName "${toolName}" — falling back to regex.` });
    return null;
  }

  const requiredParams = TOOL_PARAM_REQUIREMENTS[toolName];
  const paramsObj = parsed.params && typeof parsed.params === 'object' ? parsed.params : {};
  // Required string params must be defined AND survive a trim — checking
  // `=== undefined` alone let null/""/whitespace-only values through
  // (e.g. GMAIL_SEARCH {query: null}, SET_MODEL_TIER {tier: ""}), which
  // produced broken dispatches instead of falling back to the regex reasoner.
  const missing = requiredParams.filter(
    key => typeof paramsObj[key] !== 'string' || paramsObj[key].trim().length === 0
  );
  if (missing.length) {
    onLog({ type: 'WARNING', message: `[AI INTENT CLASSIFIER] "${toolName}" missing/empty required params (${missing.join(', ')}) — falling back to regex.` });
    return null;
  }

  const decision = {
    shouldCallTool: toolName !== 'CONVERSATIONAL',
    toolName,
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8,
    params: paramsObj,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'AI intent classifier decision.'
  };

  onLog({ type: 'SUCCESS', message: `[AI INTENT CLASSIFIER] "${input}" -> ${toolName} (${(decision.confidence * 100).toFixed(0)}%)` });
  return decision;
}
