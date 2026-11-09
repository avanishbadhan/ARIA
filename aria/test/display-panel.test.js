/** Pure checks for the display popup's SVG sanitizer (node-runnable — no DOM). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSvg, normalizeSvg } from '../src/display-panel.js';

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

// ---- normalizeSvg: keep oversized drawings inside the panel ----

test('normalizeSvg derives a viewBox from fixed width/height so the drawing scales to the panel', () => {
  // Observed live: the solar system came back at width="800" with no viewBox
  // and rendered at its raw coordinate size, blowing way past the display.
  const stubEl = {
    attrs: new Map(),
    querySelector: () => null,
    getAttribute(n) { return this.attrs.get(n); },
    setAttribute(n, v) { this.attrs.set(n, v); },
    removeAttribute(n) { this.attrs.delete(n); }
  };
  globalThis.DOMParser = class {
    parseFromString() {
      stubEl.attrs = new Map([['width', '800'], ['height', '600']]);
      return { querySelector: (sel) => (sel === 'svg' ? stubEl : null) };
    }
  };
  globalThis.XMLSerializer = class {
    serializeToString(el) {
      return `<svg viewBox="${el.getAttribute('viewBox')}">x</svg>`;
    }
  };
  try {
    const out = normalizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><circle cx="400" cy="300" r="10"/></svg>');
    assert.ok(out.includes('viewBox="0 0 800 600"'), 'derived viewBox from width/height');
    assert.ok(!out.includes('width="800"'), 'fixed pixel width removed');
  } finally {
    delete globalThis.DOMParser;
    delete globalThis.XMLSerializer;
  }
});

test('normalizeSvg keeps an existing viewBox and strips fixed dimensions', () => {
  const out = normalizeSvg('<svg viewBox="0 0 400 300" width="400" height="300"><circle/></svg>');
  assert.ok(out.includes('viewBox="0 0 400 300"'));
  assert.ok(!/width=/.test(out));
  assert.ok(!/height=/.test(out));
});
