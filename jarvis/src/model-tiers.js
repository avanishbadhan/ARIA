/**
 * Model tiers JARVIS can switch between via the HUD slider or a voice
 * command ("switch mode to high"). Quick/Medium/High run on Groq (model IDs
 * verified against console.groq.com/docs/models — update here if Groq
 * deprecates one); Ultra runs on Gemini instead (see gemini-client.js) for
 * its larger context window and multimodal reasoning.
 */

export const MODEL_TIERS = {
  // llama-3.1-8b-instant is being decommissioned by Groq — openai/gpt-oss-20b
  // is configured as its fallback (see getModelQueue) so quick-tier requests
  // keep working once Groq turns it off, with no code change needed here.
  quick: { provider: 'groq', model: 'llama-3.1-8b-instant', fallbackModels: ['openai/gpt-oss-20b'], label: 'Quick' },
  medium: { provider: 'groq', model: 'llama-3.3-70b-versatile', label: 'Medium' },
  high: { provider: 'groq', model: 'openai/gpt-oss-120b', label: 'High' },
  // Gemini — requires its own API key (Settings). Falls back through
  // progressively older Gemini models rather than to a different provider,
  // so an Ultra request stays on Gemini as long as any key-eligible model
  // is reachable; only exhausting this whole queue falls through to
  // Groq/OpenRouter (see JarvisCore._chatWithActiveLLM).
  ultra: { provider: 'gemini', model: 'gemini-2.5-pro', fallbackModels: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'], label: 'Ultra' }
};

export const TIER_ORDER = ['quick', 'medium', 'high', 'ultra'];

/**
 * Full ordered list of model IDs to try for a tier — the primary model
 * followed by any configured fallbacks. Returns [] for an unknown tier or
 * one whose provider doesn't consume this queue (only groq-client.js and
 * gemini-client.js call this, each passing their own tier keys).
 */
export function getModelQueue(tierKey) {
  const tier = MODEL_TIERS[tierKey];
  if (!tier) return [];
  return [tier.model, ...(tier.fallbackModels || [])];
}

const ALIASES = {
  quick: 'quick', low: 'quick', fast: 'quick',
  medium: 'medium', mid: 'medium',
  high: 'high',
  ultra: 'ultra', max: 'ultra', maximum: 'ultra'
};

/**
 * Normalizes a spoken/typed word to a canonical tier key, or null if it
 * isn't a recognized tier — callers should treat null as "not a tier
 * command" rather than guessing.
 */
export function normalizeTierAlias(word) {
  if (!word) return null;
  return ALIASES[word.toLowerCase()] || null;
}
