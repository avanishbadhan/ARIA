/**
 * Some reasoning models (e.g. Groq's qwen/qwen3.6-27b) prefix responses with
 * a <think>...</think> chain-of-thought block before the real answer.
 * Strips it so callers only ever see the final answer, never raw reasoning.
 * If the block never closes (the model ran out of tokens mid-thought, so
 * there's no real answer at all), returns '' — callers treat that the same
 * as an empty completion and fall through to the next model.
 */
function stripThinkTags(content) {
  const withoutClosedBlocks = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // A <think> left over after removing closed pairs means it never closed
  // (ran out of tokens mid-thought) — nothing after it is a real answer.
  if (/<think>/i.test(withoutClosedBlocks)) return '';
  return withoutClosedBlocks.trim();
}

/**
 * Posts one chat-completion request for a single model/message-array pair.
 * Split out of fetchChatCompletion so a tool-call follow-up round can re-POST
 * to the same model without re-running the modelQueue loop.
 */
async function postChatCompletion({ baseUrl, headers, model, messages, temperature, maxTokens, tools, extraBody }) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
      ...extraBody
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `HTTP ${response.status}`);
  }
  return data;
}

/**
 * Shared OpenAI-compatible chat-completion loop: cycles through a provider's
 * modelQueue on failure (rate limit, outage, empty response) until one
 * succeeds or the queue is exhausted. Used by both OpenRouterClient and
 * GroqClient, which only differ in baseUrl/headers/modelQueue/logPrefix.
 *
 * tools/toolExecutor (both optional) enable autonomous function-calling: if
 * a model responds with tool_calls, they're executed locally via
 * toolExecutor and the results are fed back to the SAME model for one
 * grounded follow-up round — these are single-shot lookups (see
 * src/jarvis-tools.js), not a multi-step agent loop. Omitting tools
 * reproduces the exact prior request shape and behavior.
 */
export async function fetchChatCompletion({ baseUrl, headers, modelQueue, messages, onLog = () => {}, logPrefix, temperature = 0.7, maxTokens = 350, extraBody = {}, tools = null, toolExecutor = null }) {
  let lastError = null;
  for (const model of modelQueue) {
    try {
      onLog({ type: 'HARNESS', message: `[${logPrefix}] Trying model: ${model}` });

      let data = await postChatCompletion({ baseUrl, headers, model, messages, temperature, maxTokens, tools, extraBody });
      let message = data.choices?.[0]?.message;

      if (tools && toolExecutor && message?.tool_calls?.length) {
        const followUpMessages = [...messages, message];
        for (const call of message.tool_calls) {
          const result = await toolExecutor(call.function?.name, call.function?.arguments);
          followUpMessages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
        }
        data = await postChatCompletion({ baseUrl, headers, model, messages: followUpMessages, temperature, maxTokens, tools, extraBody });
        message = data.choices?.[0]?.message;
      }

      if (message?.content) {
        const cleaned = stripThinkTags(message.content);
        if (cleaned) {
          onLog({ type: 'SUCCESS', message: `[${logPrefix}] Response from ${model}` });
          return cleaned;
        }
        onLog({ type: 'WARNING', message: `[${logPrefix}] ${model} returned only reasoning, no final answer. Trying next model...` });
        lastError = new Error("Response contained no usable content after stripping reasoning.");
        continue;
      }

      lastError = new Error("Empty completion returned.");
    } catch (e) {
      lastError = e;
      onLog({ type: 'WARNING', message: `[${logPrefix}] ${model} failed: ${e.message}. Trying next model...` });
    }
  }

  throw lastError || new Error(`All ${logPrefix} models exhausted.`);
}
