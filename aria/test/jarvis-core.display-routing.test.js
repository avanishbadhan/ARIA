/**
 * Tests that visual answers route to the big display popup: math results
 * push a text display, and DRAW_DISPLAY produces an SVG (or falls back to
 * text) on the display panel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvis } from './helpers/jarvis-test-utils.js';

test('a Wolfram-answered math query pushes a typeset work display titled with the query', async () => {
  const jarvis = createJarvis();
  jarvis.wolfram.solve = async () => 'The result is 8';
  const displays = [];
  jarvis.onDisplay = (payload) => displays.push(payload);

  await jarvis.processUserInput('what is 5 plus 3');

  assert.equal(displays.length, 1);
  assert.equal(displays[0].kind, 'text');
  assert.equal(displays[0].title, 'what is 5 plus 3');
  assert.equal(displays[0].body, 'mock-answer:1', 'the LLM-produced typeset work');
});

test('DRAW_DISPLAY renders an SVG produced by the LLM onto the display, with a generous token budget', async () => {
  const jarvis = createJarvis();
  const displays = [];
  jarvis.onDisplay = (payload) => displays.push(payload);
  let capturedOptions = null;
  const svg = '<svg viewBox="0 0 100 100"><circle cx="10" cy="10" r="5"/></svg>';
  jarvis._chatWithActiveLLM = async (input, context, options) => {
    capturedOptions = options;
    return '```svg\n' + svg + '\n```';
  };

  await jarvis.processUserInput('draw a solar system');

  assert.equal(displays.length, 1);
  assert.equal(displays[0].kind, 'svg');
  assert.equal(displays[0].title, 'a solar system');
  assert.equal(displays[0].body, svg);
  assert.ok(capturedOptions && capturedOptions.maxTokens >= 2000, 'SVG drawings need far more than the chat default');
  // The script tag sanitizer is exercised end-to-end in display-panel.test.js;
  // here we just assert the raw SVG reached the display untouched.
});

test('DRAW_DISPLAY salvages a token-truncated SVG response', async () => {
  const jarvis = createJarvis();
  const displays = [];
  jarvis.onDisplay = (payload) => displays.push(payload);
  // Observed live: the water-cycle drawing died mid-<circle … r with no
  // closing tag when the model hit the token wall.
  const cut = '```svg\n<svg viewBox="0 0 400 300"><rect width="300" height="10"/><circle cx="260" cy="170" r="8"';
  jarvis._chatWithActiveLLM = async () => cut;

  await jarvis.processUserInput('draw the water cycle');

  assert.equal(displays.length, 1);
  assert.equal(displays[0].kind, 'svg', 'truncation is salvaged instead of falling back to raw text');
  assert.ok(displays[0].body.startsWith('<svg'));
  assert.ok(displays[0].body.endsWith('</svg>'));
  assert.ok(displays[0].body.includes('<circle'));
});

test('DRAW_DISPLAY falls back to text when the model produced no SVG', async () => {
  const jarvis = createJarvis();
  const displays = [];
  jarvis.onDisplay = (payload) => displays.push(payload);

  await jarvis.processUserInput('draw a cat');

  assert.equal(displays.length, 1);
  assert.equal(displays[0].kind, 'text');
  assert.equal(displays[0].body, 'mock-answer:1');
  assert.equal(displays[0].title, 'a cat');
});

test('DRAW_DISPLAY never touches WolframAlpha', async () => {
  const jarvis = createJarvis();
  jarvis.wolframCalls = [];
  jarvis.wolfram.solve = async (query) => { jarvis.wolframCalls.push(query); return null; };
  jarvis._chatWithActiveLLM = async () => '```svg\n<svg>...</svg>\n```';

  await jarvis.processUserInput('draw a cat');

  assert.equal(jarvis.wolframCalls.length, 0);
});
