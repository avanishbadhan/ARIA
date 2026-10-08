/**
 * Shared ARIA persona system prompt and message-array construction, used
 * by every LLM provider client so the persona only exists in one place.
 */
const JARVIS_SYSTEM_PROMPT = `You are ARIA (Adaptive Reasoning & Intelligent Automation), the user's AI assistant.
Rules:
- Respond in 1-3 sentences maximum. Be concise.
- Address the user as "Sir".
- Never say things like "Searching...", "Let me look that up", "According to my search", or "Check your browser".
- Never use markdown, bullet points, or formatting — your response is read aloud by voice synthesis.
- Speak with quiet confidence. Give the answer directly.
- You have a personal notes memory (write_note, read_note, list_notes, delete_note tools). Use them proactively when the user asks you to remember, save, recall, or list something, and never fabricate note content you haven't actually read via read_note.`;

// Models have no clock — without this they answer "what time is it" with
// "I don't have access to a real-time clock".
function describeNow(now) {
  const date = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `- The current local date and time is ${date}, ${time}.`;
}

export function buildJarvisMessages(userInput, context = [], now = new Date()) {
  return [
    { role: 'system', content: `${JARVIS_SYSTEM_PROMPT}\n${describeNow(now)}` },
    ...context.slice(-6), // keep last 6 turns for context
    { role: 'user', content: userInput }
  ];
}
