/**
 * OpenRouter AI Client for JARVIS
 * Routes conversational requests through OpenRouter's free model pool with
 * automatic failover across verified working free endpoints.
 */

import { fetchChatCompletion } from './llm-completion.js';
import { buildJarvisMessages } from './llm-persona.js';

/**
 * OpenRouter's optional HTTP-Referer attribution header. Only sent when the
 * renderer origin is a real http(s) URL — the packaged file:// build reports
 * origin "file://" (or even "null"), which OpenRouter rejects as garbage.
 */
function refererHeader() {
  const origin = typeof window !== 'undefined' ? window.location?.origin || '' : '';
  return /^https?:\/\//i.test(origin) ? { 'HTTP-Referer': origin } : {};
}

export class OpenRouterClient {
  constructor(apiKey = '', options = {}) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://openrouter.ai/api/v1/chat/completions';
    this.onLog = options.onLog || (() => {});

    // Ordered list of verified working free models (as of Aug 2026)
    // openrouter/free = OpenRouter's own dynamic free model router (best first-try)
    // options.modelQueue overrides this — used by JarvisCore to build a
    // second OpenRouterClient instance pinned to Hermes models instead of
    // the free pool (same API key/transport, different queue). See
    // docs/superpowers/specs/2026-08-15-hermes-mcp-web-access-design.md.
    this.modelQueue = options.modelQueue || [
      'openrouter/free',
      'nvidia/nemotron-nano-9b-v2:free',
      'nvidia/nemotron-nano-12b-v2-vl:free',
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-super-120b-a12b:free'
    ];

    // Dedicated single-model queue for screen-vision requests — nemotron-nano-12b-v2-vl
    // is the one genuinely vision-capable ("vl") model in the free pool; the rest
    // of modelQueue above is text-only and can't accept image content.
    this.visionModelQueue = ['nvidia/nemotron-nano-12b-v2-vl:free'];
  }

  /**
   * Attempts chat completion cycling through the model queue on failure.
   * options.tools/options.toolExecutor (both optional) enable autonomous
   * function-calling — see src/jarvis-tools.js.
   */
  async generateCompletion(messages, options = {}) {
    if (!this.apiKey) throw new Error("OpenRouter API Key not configured.");

    return fetchChatCompletion({
      baseUrl: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...refererHeader(),
        'X-Title': 'JARVIS Voice AI System'
      },
      modelQueue: this.modelQueue,
      messages,
      onLog: this.onLog,
      logPrefix: 'OPENROUTER',
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      tools: options.tools,
      toolExecutor: options.toolExecutor
    });
  }

  /**
   * Vision-capable completion for screen-vision questions — see
   * docs/superpowers/specs/2026-08-12-screen-vision-and-ai-reasoner-design.md.
   */
  async generateVisionCompletion(messages, options = {}) {
    if (!this.apiKey) throw new Error("OpenRouter API Key not configured.");

    return fetchChatCompletion({
      baseUrl: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...refererHeader(),
        'X-Title': 'JARVIS Voice AI System'
      },
      modelQueue: this.visionModelQueue,
      messages,
      onLog: this.onLog,
      logPrefix: 'OPENROUTER VISION',
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      tools: options.tools,
      toolExecutor: options.toolExecutor
    });
  }

  /**
   * Generates a JARVIS-persona voice response for the given user input.
   * options.tools/options.toolExecutor pass straight through to
   * generateCompletion — see src/jarvis-tools.js.
   */
  async chatWithJarvis(userInput, context = [], options = {}) {
    try {
      return await this.generateCompletion(buildJarvisMessages(userInput, context), options);
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[OPENROUTER FALLBACK] ${err.message}` });
      return null; // null triggers local knowledge base fallback in JarvisCore
    }
  }
}
