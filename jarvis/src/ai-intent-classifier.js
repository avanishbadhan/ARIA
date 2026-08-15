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
  SCREEN_QUERY: ['question'],
  CONVERSATIONAL: []
};

export const INTENT_CLASSIFIER_SYSTEM_PROMPT = `You are JARVIS's intent classifier. Given the user's utterance, decide which
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
- OPEN_SITE: { siteName: string }
- MATH_QUERY: { query: string }
- SET_MODEL_TIER: { tier: "quick"|"medium"|"high"|"ultra" }
- SCREEN_MONITOR_START: {}
- SCREEN_MONITOR_STOP: {}
- SCREEN_QUERY: { question: string }
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
  const missing = requiredParams.filter(key => paramsObj[key] === undefined);
  if (missing.length) {
    onLog({ type: 'WARNING', message: `[AI INTENT CLASSIFIER] "${toolName}" missing required params (${missing.join(', ')}) — falling back to regex.` });
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
