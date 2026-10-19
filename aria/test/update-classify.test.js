import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUpdate } from '../electron/update-classify.cjs';

test('classifies a major version bump as major', () => {
  assert.equal(classifyUpdate('1.4.2', '2.0.0'), 'major');
});

test('classifies a minor version bump as minor', () => {
  assert.equal(classifyUpdate('1.4.2', '1.5.0'), 'minor');
});

test('classifies a patch version bump as minor', () => {
  assert.equal(classifyUpdate('1.4.2', '1.4.3'), 'minor');
});

test('classifies an equal version as none', () => {
  assert.equal(classifyUpdate('1.4.2', '1.4.2'), 'none');
});

test('classifies an older version as none', () => {
  assert.equal(classifyUpdate('2.0.0', '1.9.9'), 'none');
});

test('classifies a multi-major jump as major', () => {
  assert.equal(classifyUpdate('1.0.0', '4.0.0'), 'major');
});
