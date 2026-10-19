/**
 * Shared test setup for JarvisCore specs: shims the localStorage global that
 * JarvisCore's constructor chain reads, and builds a JarvisCore wired to
 * inert mocks (no voice synthesis, no browser automation, no network) with
 * an OpenRouter stub that records every (input, context) call instead of
 * hitting the real API.
 */

global.localStorage = global.localStorage || {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, val) { this.store.set(key, String(val)); },
  removeItem(key) { this.store.delete(key); }
};

const { JarvisCore } = await import('../../src/jarvis-core.js');

export function createJarvis(harnessOverrides = {}) {
  const voiceEngine = {
    playBeep: () => {},
    playSearchLaunchSound: () => {},
    speak: async () => {}
  };
  const harness = {
    executeGoogleSearch: async () => ({ summary: 'mock search summary.' }),
    openWebsite: () => ({}),
    ...harnessOverrides
  };

  const jarvis = new JarvisCore(voiceEngine, harness);

  jarvis.llmCalls = [];
  jarvis.openRouter.chatWithJarvis = async (input, context = []) => {
    jarvis.llmCalls.push({ input, context: context.map(m => ({ ...m })) });
    return `mock-answer:${jarvis.llmCalls.length}`;
  };

  // Default: AI-first classification is "unavailable" so every test exercises
  // the regex reasoner deterministically and never makes a real network call.
  // Tests exercising the AI classification path override this directly.
  jarvis._classifyIntentWithAI = async () => null;

  return jarvis;
}
