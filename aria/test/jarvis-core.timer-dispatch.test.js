import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

function decide(jarvis, toolName, params) {
  // The AI-first classifier wrapper consults jarvis._classifyIntentWithAI,
  // whose contract is "return raw LLM output text" (it is JSON-validated
  // downstream). So the override returns a JSON string — same pattern as
  // test/ai-intent-classifier.test.js's stubs.
  jarvis._classifyIntentWithAI = async () => JSON.stringify({
    shouldCallTool: true, toolName, params,
    confidence: 0.95, reasoning: 'test override'
  });
}

test('SET_TIMER schedules a real timer and announces completion', async () => {
  const jarvis = createJarvis();
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(String(text)); };
  const responded = [];
  jarvis.onResponse = (r) => responded.push(r);

  decide(jarvis, 'SET_TIMER', { duration: '0.1 seconds' });
  await jarvis.processUserInput('set a timer for 0.1 seconds');

  assert.equal(responded[0].actionType, 'SET_TIMER');
  assert.equal(responded[0].data.durationMs, 100);
  assert.match(spoken[0], /Timer set for/i);
  assert.equal(jarvis.timerStore.list().length, 1);

  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(jarvis.timerStore.list().length, 0);
  assert.ok(spoken.some((s) => /gone off/i.test(s)),
    `expected expiry announcement, got: ${JSON.stringify(spoken)}`);
});

test('TIMER_CANCEL cancels the running timer instead of leaving it armed', async () => {
  const jarvis = createJarvis();
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(String(text)); };
  const responded = [];
  jarvis.onResponse = (r) => responded.push(r);

  decide(jarvis, 'SET_TIMER', { duration: '0.1 seconds' });
  await jarvis.processUserInput('set a timer for 0.1 seconds');
  decide(jarvis, 'TIMER_CANCEL', {});
  await jarvis.processUserInput('cancel the timer');

  assert.equal(responded[1].actionType, 'TIMER_CANCEL');
  assert.equal(responded[1].data.cancelled, 1);
  assert.match(spoken[1], /Cancelled 1 timer/);

  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(jarvis.timerStore.list().length, 0);
  assert.ok(spoken.every((s) => !/gone off/i.test(s)),
    'cancelled timer must not announce expiry');
});

test('SET_TIMER without a parseable duration asks for one instead of hallucinating', async () => {
  const jarvis = createJarvis();
  const spoken = [];
  jarvis.voiceEngine.speak = async (text) => { spoken.push(String(text)); };
  const responded = [];
  jarvis.onResponse = (r) => responded.push(r);

  decide(jarvis, 'SET_TIMER', { duration: 'pretty soon' });
  await jarvis.processUserInput('set a timer pretty soon');

  assert.equal(responded[0].actionType, 'SET_TIMER');
  assert.match(spoken[0], /couldn't work out a duration/i);
  assert.equal(jarvis.timerStore.list().length, 0);
});
