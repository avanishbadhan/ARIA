/**
 * Groq model tiers JARVIS can switch between via the HUD slider or a voice
 * command ("switch mode to high"). Model IDs verified against
 * console.groq.com/docs/models — update here if Groq deprecates one.
 */

export const MODEL_TIERS = {
  // llama-3.1-8b-instant is being decommissioned by Groq — openai/gpt-oss-20b
  // is configured as its fallback (see getModelQueue) so quick-tier requests
  // keep working once Groq turns it off, with no code change needed here.
  quick: { model: 'llama-3.1-8b-instant', fallbackModels: ['openai/gpt-oss-20b'], label: 'Quick' },
  medium: { model: 'llama-3.3-70b-versatile', label: 'Medium' },
  high: { model: 'openai/gpt-oss-120b', label: 'High' },
  // Groq's agentic system — can autonomously invoke web search/code
  // execution mid-response. The only option above gpt-oss-120b on Groq's
  // free tier; called through the same chat-completions shape as the rest.
  ultra: { model: 'groq/compound', label: 'Ultra' }
};

export const TIER_ORDER = ['quick', 'medium', 'high', 'ultra'];

/**
 * Full ordered list of model IDs to try for a tier — the primary model
 * followed by any configured fallbacks. Returns [] for an unknown tier.
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
