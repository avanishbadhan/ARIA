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
  /**
   * Converts JARVIS's OpenAI-style tool schema (see GROUNDING_TOOLS in
   * jarvis-tools.js) into Gemini's functionDeclarations shape. Each entry is
   * `{ type: 'function', function: { name, description, parameters } }`.
   */
  _toFunctionDeclarations(tools) {
    if (!Array.isArray(tools)) return null;
    const declarations = tools
      .map((t) => {
        const fn = t?.function || t;
        if (!fn || !fn.name) return null;
        return {
          name: fn.name,
          description: fn.description || '',
          parameters: fn.parameters || { type: 'object', properties: {} }
        };
      })
      .filter(Boolean);
    return declarations.length ? { functionDeclarations: declarations } : null;
  }

  /**
   * Runs a single model attempt, handling the autonomous function-calling
   * loop: if the model returns a functionCall part, execute it via
   * options.toolExecutor and feed the result back as a functionResponse so
   * the SAME model can finish its answer. Mirrors the tool loop in
   * llm-completion.js, adapted to Gemini's functionCall/functionResponse
   * content parts.
   */
  async _runModel(model, initialContents, options, prefixBody) {
    const body = {
      ...(prefixBody || {}),
      contents: initialContents
    };
    if (options.maxTokens || options.temperature !== undefined) {
      body.generationConfig = {
        ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {})
      };
    }
    const functionDeclarations = this._toFunctionDeclarations(options.tools);
    if (functionDeclarations) body.tools = [functionDeclarations];

    const url = `${this.baseUrl}/${model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const maxToolRounds = 5;

    for (let round = 0; round <= maxToolRounds; round++) {
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
        throw new Error(data?.error?.message || `HTTP ${response.status}`);
      }

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => p.text || '').join(' ').trim();
      const fnCall = parts.find((p) => p.functionCall);

      // Model requested a tool. Execute it and continue the conversation with
      // the result (echo the functionCall back as a model part, then add the
      // functionResponse as a user part) so it can answer using the data.
      if (fnCall?.functionCall?.name) {
        if (!options.toolExecutor) {
          // No executor available — return whatever text came with the call.
          if (text) return text;
          throw new Error("Empty completion returned.");
        }
        const call = fnCall.functionCall;
        const argsJson = JSON.stringify(call.args || {});
        const result = await options.toolExecutor(call.name, argsJson);

        // Gemini 3 now requires the model's `thoughtSignature` to be echoed
        // back exactly as received when continuing a tool conversation —
        // omitting it makes the API reject with "Function call is missing a
        // thought_signature". It arrives as a camelCase sibling of the
        // `functionCall` within the SAME content part (NOT inside the
        // functionCall object), and must be echoed back at that same
        // part-level spot. See
        // https://ai.google.dev/gemini-api/docs/thought-signatures.
        const echoPart = { functionCall: { name: call.name, args: call.args || {} } };
        const signature = fnCall.thoughtSignature || fnCall.thought_signature;
        if (signature) echoPart.thoughtSignature = signature;

        body.contents.push({
          role: 'model',
          parts: [echoPart]
        });
        body.contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: call.name, response: { result } } }]
        });
        continue;
      }

      if (text) return text;
      throw new Error("Empty completion returned.");
    }

    throw new Error("Too many function call rounds.");
  }

  async generateCompletion(messages, options = {}) {
    if (!this.apiKey) throw new Error("Gemini API Key not configured.");

    // system_instruction is built once here so _runModel can freely mutate
    // body.contents across tool rounds without rebuilding the whole body.
    const systemParts = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean);
    const initialContents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: contentToParts(m.content)
      }));

    const prefixBody = {};
    if (systemParts.length) {
      prefixBody.system_instruction = { parts: [{ text: systemParts.join('\n\n') }] };
    }

    let lastError = null;
    for (const model of this.modelQueue) {
      try {
        this.onLog({ type: 'HARNESS', message: `[GEMINI] Trying model: ${model}` });
        const answer = await this._runModel(model, initialContents, options, prefixBody);
        this.onLog({ type: 'SUCCESS', message: `[GEMINI] Response from ${model}` });
        return answer;
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
