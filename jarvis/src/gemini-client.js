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
 * Converts one message's content into Gemini "parts". Plain string content
 * (normal chat) becomes a single text part. Array content — JARVIS's
 * OpenAI-style vision message shape, [{type:'text',...}, {type:'image_url',
 * image_url:{url: 'data:...;base64,...'}}] — becomes a text part plus an
 * inlineData part per image, which is how Gemini accepts images in the same
 * generateContent call as the question (no separate vision endpoint/model,
 * unlike Groq/OpenRouter).
 */
function contentToParts(content) {
  if (typeof content === 'string') return [{ text: content }];

  return content
    .map((item) => {
      if (item.type === 'text') return { text: item.text };
      if (item.type === 'image_url') {
        const match = (item.image_url?.url || '').match(/^data:([^;]+);base64,(.+)$/);
        if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Converts JARVIS's OpenAI-style {role, content} message array into
 * Gemini's shape: a single system_instruction string plus a contents array
 * using Gemini's role names ('model' instead of 'assistant').
 */
function toGeminiRequestBody(messages) {
  const systemParts = messages.filter(m => m.role === 'system').map(m => (typeof m.content === 'string' ? m.content : '')).filter(Boolean);
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: contentToParts(m.content)
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

        // Read the body even on failure — Google's error responses include a
        // real message (e.g. "models/x is not found for API version v1beta")
        // that's the only way to tell a bad model name apart from a bad key
        // or a rate limit. Swallowing it down to a bare "HTTP 404" made a
        // real production failure undebuggable (see incident where every
        // model in the queue 404'd and the log gave no reason why).
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          lastError = new Error(data?.error?.message || `HTTP ${response.status}`);
          this.onLog({ type: 'WARNING', message: `[GEMINI] ${model} failed: ${lastError.message}. Trying next model...` });
          continue;
        }

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim()) {
          this.onLog({ type: 'SUCCESS', message: `[GEMINI] Response from ${model}` });
          return text.trim();
        }

        lastError = new Error("Empty completion returned.");
        this.onLog({ type: 'WARNING', message: `[GEMINI] ${model} returned no usable content. Trying next model...` });
      } catch (e) {
        lastError = e;
        this.onLog({ type: 'WARNING', message: `[GEMINI] ${model} failed: ${e.message}. Trying next model...` });
      }
    }

    throw lastError || new Error("All GEMINI models exhausted.");
  }

  /**
   * Vision completion — unlike GroqClient/OpenRouterClient, Gemini needs no
   * separate vision model queue: every model in this.modelQueue accepts
   * inline image parts in the same generateContent call as the text, so
   * this is a thin alias kept for interface parity with the other two
   * clients (JarvisCore._askVisionLLM calls whichever one is active the
   * same way regardless of provider).
   */
  async generateVisionCompletion(messages, options = {}) {
    return this.generateCompletion(messages, options);
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
