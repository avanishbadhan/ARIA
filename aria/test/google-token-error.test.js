import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGoogleTokenError } from '../electron/google-token-error.cjs';

test('invalid_grant is flagged as revoked with a reconnect message', () => {
  const result = describeGoogleTokenError(400, { error: 'invalid_grant', error_description: 'Bad Request' });
  assert.equal(result.revoked, true);
  assert.match(result.message, /reconnect/i);
  assert.match(result.message, /invalid_grant/);
});

test('other errors keep both the code and description', () => {
  const result = describeGoogleTokenError(401, { error: 'invalid_client', error_description: 'Unauthorized' });
  assert.equal(result.revoked, false);
  assert.equal(result.message, 'Google token exchange failed (invalid_client): Unauthorized');
});

test('falls back to the HTTP status when the body has no error fields', () => {
  const result = describeGoogleTokenError(500, {});
  assert.equal(result.revoked, false);
  assert.equal(result.message, 'Google token exchange HTTP 500');
});
