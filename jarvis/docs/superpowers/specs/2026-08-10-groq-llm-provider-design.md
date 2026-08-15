# Groq LLM Provider — Design

## Problem
OpenRouter's free model pool is slow for basic conversation. Groq serves
`llama-3.1-8b-instant` (and other Llama models) with much lower latency on a
free tier. Add it as a switchable second provider.

## New files

**`src/llm-persona.js`** — extracts the JARVIS system prompt + message-array
construction that currently lives inline in `OpenRouterClient.chatWithJarvis()`.
Exports `buildJarvisMessages(userInput, context = [])`. Both `OpenRouterClient`
and the new `GroqClient` use it, so the persona only exists in one place.

**`src/llm-completion.js`** — extracts the model-queue retry/fetch loop
currently inside `OpenRouterClient.generateCompletion()` (~40 lines: iterate
`modelQueue`, POST, handle non-OK responses by trying the next model, parse
`choices[0].message.content`). Exports
`fetchChatCompletion({ baseUrl, headers, modelQueue, messages, onLog })`.
Both clients become thin config wrappers around it. This is a real
duplication-avoidance move, not speculative: `GroqClient` needs the identical
loop, and OpenAI-compatible chat completion responses mean the parsing logic
is byte-for-byte the same.

**`src/groq-client.js`** — `GroqClient`, same public shape as
`OpenRouterClient` (`apiKey`, `generateCompletion(messages)`,
`chatWithJarvis(userInput, context)`). Endpoint:
`https://api.groq.com/openai/v1/chat/completions`. Model queue:
`['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']` — instant model first
for speed, 70B as a fallback if the first is rate-limited/unavailable. No
`HTTP-Referer`/`X-Title` headers (those are OpenRouter-specific attribution
headers Groq doesn't use).

## Settings
New boolean `useGroq` in `DEFAULT_SETTINGS`, default `false` — preserves
current behavior for anyone already using this. Surfaced as a Y/N switch
(reusing the existing `.settings-switch` component) labeled "Use Groq
(faster) instead of OpenRouter."

## Fallback chain
`JarvisCore` constructs both `this.openRouter` and `this.groq` (mirroring the
existing `jarvis_openrouter_api_key`/localStorage pattern with a new
`jarvis_groq_api_key`). New private method:

```js
async _chatWithActiveLLM(userInput, context) {
  if (loadSettings().useGroq) {
    const groqAnswer = await this.groq.chatWithJarvis(userInput, context);
    if (groqAnswer) return groqAnswer;
  }
  return this.openRouter.chatWithJarvis(userInput, context);
}
```

Both existing call sites (`processUserInput`'s Google-search branch and the
main conversational branch) call this instead of
`this.openRouter.chatWithJarvis` directly. `chatWithJarvis` on both clients
already returns `null` on any failure (bad/missing key, network error, all
models exhausted) rather than throwing, so `_chatWithActiveLLM` composes
cleanly with zero new error-handling: Groq → OpenRouter → (existing,
untouched) local-knowledge-base fallback already in `jarvis-core.js`.

## UI
API Keys section in the Settings modal gets a third password input, "Groq
API Key," matching the OpenRouter/Deepgram pattern (mask-after-save,
live-updates `jarvis.groq.apiKey` with no reload). A new toggle row above the
existing sections (or alongside — placement in General) for the `useGroq`
switch, with a hint line: "Get a free key at console.groq.com/keys."

## Docs
`.env.example` and `README.md` gain a `VITE_GROQ_API_KEY` row.

## Testing
- `test/llm-persona.test.js` — `buildJarvisMessages` includes the system
  prompt, slices context to the last 6 entries, appends the user message
  last.
- `test/jarvis-core.llm-provider.test.js` — three cases via
  `createJarvis()`: (1) `useGroq` false (default) → only `openRouter.chatWithJarvis`
  is called, matching existing conversation-memory tests' assumption; (2)
  `useGroq` true + Groq stub returns an answer → OpenRouter is never called;
  (3) `useGroq` true + Groq stub returns `null` → falls through to OpenRouter,
  whose stub answer is used.

## Out of scope
- No UI for picking which Groq model / reordering the queue — the two-model
  fallback is fixed in code, matching how OpenRouter's 5-model queue already
  isn't user-configurable either.
- No change to the existing OpenRouter/Deepgram/Steam settings or panels
  beyond adding the new Groq row alongside them.
