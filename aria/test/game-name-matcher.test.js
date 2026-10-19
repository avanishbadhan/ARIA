import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatchGameName } from '../src/game-name-matcher.js';

function item(name) {
  return { name, nameLower: name.toLowerCase() };
}

const library = [item('Counter-Strike 2'), item('Dota 2'), item("Baldur's Gate 3"), item('Rainbow Six Siege')];

test('returns null for an empty item list', () => {
  assert.equal(fuzzyMatchGameName('dota', []), null);
});

test('exact match wins immediately', () => {
  const result = fuzzyMatchGameName('dota 2', library);
  assert.equal(result.name, 'Dota 2');
});

test('matches when the item name contains the query', () => {
  const result = fuzzyMatchGameName('dota', library);
  assert.equal(result.name, 'Dota 2');
});

test('matches when the query contains the full item name (spoken subtitle)', () => {
  const result = fuzzyMatchGameName("play baldur's gate 3", library);
  assert.equal(result.name, "Baldur's Gate 3");
});

test('token overlap matches reordered multi-word titles (neither substring check catches word-order swaps)', () => {
  const result = fuzzyMatchGameName('six rainbow', library);
  assert.equal(result.name, 'Rainbow Six Siege');
});

test('returns null when nothing scores above the 0.5 threshold', () => {
  const result = fuzzyMatchGameName('some totally unrelated title', library);
  assert.equal(result, null);
});

test('normalizes smart quotes and strips punctuation before matching', () => {
  const result = fuzzyMatchGameName('baldur’s gate 3!', library);
  assert.equal(result.name, "Baldur's Gate 3");
});
