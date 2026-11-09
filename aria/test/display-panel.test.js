/** Pure checks for the display popup's SVG sanitizer (node-runnable — no DOM). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSvg } from '../src/display-panel.js';

test('strips script tags entirely', () => {
  const out = sanitizeSvg('<svg><script>alert(1)</script><circle r="2"/></svg>');
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('alert'));
  assert.ok(out.includes('<circle'));
});

test('strips event handler attributes (onload, onclick, ...)', () => {
  const out = sanitizeSvg('<svg onload="evil()"><rect onclick="bad()" width="4"/></svg>');
  assert.ok(!out.includes('onload'));
  assert.ok(!out.includes('onclick'));
  assert.ok(out.includes('<svg'));
  assert.ok(out.includes('<rect'));
});

test('strips javascript: URLs on href and xlink:href', () => {
  const out = sanitizeSvg('<svg><a href="javascript:evil()">x</a><a xlink:href="javascript:evil()">y</a></svg>');
  assert.ok(!out.includes('javascript:'));
});

test('strips foreignObject (HTML-in-SVG) blocks', () => {
  const out = sanitizeSvg('<svg><foreignObject><body><img src=x onerror=evil()></body></foreignObject><path d="M0 0"/></svg>');
  assert.ok(!out.includes('foreignObject'));
  assert.ok(out.includes('<path'));
});

test('leaves ordinary SVG markup untouched', () => {
  const svg = '<svg viewBox="0 0 100 100"><text x="10" y="10">Hello</text><circle cx="50" cy="50" r="20"/></svg>';
  assert.equal(sanitizeSvg(svg), svg);
});
