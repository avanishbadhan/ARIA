/**
 * Gemini AI Client for JARVIS
 * Powers the Ultra tier of the model-tier slider (see model-tiers.js).
 * Gemini's REST shape (system_instruction/contents/candidates) differs from
 * the OpenAI-compatible shape Groq and OpenRouter share, so this client
 * talks to it directly rather than going through llm-completion.js.
 */

import { buildJarvisMessages } from './llm-persona.js';
import { getModelQueue } from './model-tiers.js';

/**
 * Converts JARVIS's OpenAI-style {role, content} message array into
 * Gemini's shape: a single system_instruction string plus a contents array
 * using Gemini's role names ('model' instead of 'assistant').
 */
function toGeminiRequestBody(messages) {
  const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

  const body = { contents };
  if (systemParts.length) {
    body.system_instruction = { parts: [{ text: systemParts.join('\n\n') }] };
  }
  return body;
}

export class GeminiClient {
  constructor(apiKey = '', options = {}) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    this.onLog = options.onLog || (() => {});
    this.modelQueue = getModelQueue('ultra');
  }

  /**
   * Attempts a completion, cycling through the Ultra-tier model queue
   * (model-tiers.js) on failure — same "try next model" philosophy as
   * GroqClient/OpenRouterClient, adapted to Gemini's request/response shape.
   */
  async generateCompletion(messages, options = {}) {
    if (!this.apiKey) throw new Error("Gemini API Key not configured.");

    const body = toGeminiRequestBody(messages);
    if (options.maxTokens || options.temperature !== undefined) {
      body.generationConfig = {
        ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {})
      };
    }

    let lastError = null;
    for (const model of this.modelQueue) {
      try {
        this.onLog({ type: 'HARNESS', message: `[GEMINI] Trying model: ${model}` });

        const url = `${this.baseUrl}/${model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (response.status === 404 || response.status === 429) {
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }

        const data = await response.json();
        if (!response.ok) {
          lastError = new Error(data?.error?.message || `HTTP ${response.status}`);
          continue;
        }

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim()) {
          this.onLog({ type: 'SUCCESS', message: `[GEMINI] Response from ${model}` });
          return text.trim();
        }

        lastError = new Error("Empty completion returned.");
      } catch (e) {
        lastError = e;
        this.onLog({ type: 'WARNING', message: `[GEMINI] ${model} failed: ${e.message}. Trying next model...` });
      }
    }

    throw lastError || new Error("All GEMINI models exhausted.");
  }

  /**
   * Generates a JARVIS-persona voice response for the given user input.
   * Mirrors GroqClient.chatWithJarvis: returns null (rather than throwing)
   * on failure so JarvisCore can fall through to the next provider.
   */
  async chatWithJarvis(userInput, context = [], options = {}) {
    try {
      return await this.generateCompletion(buildJarvisMessages(userInput, context), options);
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[GEMINI FALLBACK] ${err.message}` });
      return null;
    }
  }
}
