/**
 * Groq AI Client for JARVIS
 * Routes conversational requests through Groq's low-latency inference API —
 * much faster than OpenRouter's free pool for basic conversation, at the
 * cost of a smaller/less capable default model.
 */

import { fetchChatCompletion } from './llm-completion.js';
import { buildJarvisMessages } from './llm-persona.js';
import { MODEL_TIERS, getModelQueue } from './model-tiers.js';

export class GroqClient {
  constructor(apiKey = '', options = {}) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.groq.com/openai/v1/chat/completions';
    this.onLog = options.onLog || (() => {});

    this.currentTier = 'quick';
    this.modelQueue = getModelQueue('quick');

    // Dedicated single-model queue for screen-vision requests — most Groq
    // text models can't accept image content, so vision calls never touch
    // the tier-based modelQueue above. meta-llama/llama-4-scout-17b-16e-instruct
    // was the original pick here but Groq deprecated it 2026-07-17; this is
    // its documented replacement (console.groq.com/docs/deprecations),
    // confirmed vision-capable (up to 5 images) as of 2026-08.  Re-verify
    // against console.groq.com/docs/models if this ever errors again.
    this.visionModelQueue = ['qwen/qwen3.6-27b'];
  }

  /**
   * Switches which Groq model this client calls, via the tier picked from
   * the HUD slider or a "switch mode to X" voice command.
   */
  setTier(tierKey) {
    const tier = MODEL_TIERS[tierKey];
    if (!tier) return;
    this.currentTier = tierKey;
    this.modelQueue = getModelQueue(tierKey);
  }

  /**
   * Attempts chat completion cycling through the model queue on failure.
   * options.tools/options.toolExecutor (both optional) enable autonomous
   * function-calling — see src/jarvis-tools.js.
   */
  async generateCompletion(messages, options = {}) {
    if (!this.apiKey) throw new Error("Groq API Key not configured.");

    return fetchChatCompletion({
      baseUrl: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      modelQueue: this.modelQueue,
      messages,
      onLog: this.onLog,
      logPrefix: 'GROQ',
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      tools: options.tools,
      toolExecutor: options.toolExecutor
    });
  }

  /**
   * Vision-capable completion for screen-vision questions — see
   * docs/superpowers/specs/2026-08-12-screen-vision-and-ai-reasoner-design.md.
   * reasoning_effort: 'none' disables qwen3.6-27b's chain-of-thought entirely
   * (Groq-specific param, only meaningful for Qwen models) — a short spoken
   * screen description doesn't need deep reasoning, and without this the
   * model was burning its whole token budget on <think>...</think> and never
   * reaching an actual answer.
   */
  async generateVisionCompletion(messages, options = {}) {
    if (!this.apiKey) throw new Error("Groq API Key not configured.");

    return fetchChatCompletion({
      baseUrl: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      modelQueue: this.visionModelQueue,
      messages,
      onLog: this.onLog,
      logPrefix: 'GROQ VISION',
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      tools: options.tools,
      toolExecutor: options.toolExecutor,
      extraBody: { reasoning_effort: 'none' }
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
      this.onLog({ type: 'WARNING', message: `[GROQ FALLBACK] ${err.message}` });
      return null; // null triggers OpenRouter fallback in JarvisCore
    }
  }
}
