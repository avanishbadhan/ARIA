import test from 'node:test';
import assert from 'node:assert/strict';

const { QUOTES, nextQuoteIndex } = await import('../src/quotes.js');

test('quote list is non-empty and every entry has real text and author', () => {
  assert.ok(QUOTES.length >= 10, 'enough quotes to avoid quick repeats');
  for (const q of QUOTES) {
    assert.equal(typeof q.text, 'string');
    assert.ok(q.text.trim().length > 10, `quote text too short: "${q.text}"`);
    assert.equal(typeof q.author, 'string');
    assert.ok(q.author.trim().length > 1, `missing author for: "${q.text}"`);
  }
});

test('quote texts are unique (no accidental duplicates)', () => {
  const texts = QUOTES.map((q) => q.text.trim());
  assert.equal(new Set(texts).size, texts.length);
});

test('nextQuoteIndex advances and wraps around the full cycle', () => {
  assert.equal(nextQuoteIndex(0), 1);
  assert.equal(nextQuoteIndex(QUOTES.length - 1), 0);
  assert.equal(nextQuoteIndex(QUOTES.length - 2), QUOTES.length - 1);
});
