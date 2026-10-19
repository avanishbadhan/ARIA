// Lives here (not in src/) because electron-builder's `files` config only
// packages electron/**/* and dist/**/* — src/ never ships, so main.cjs can't
// require anything from it at runtime after packaging.

/**
 * Turns a failed Google OAuth token-endpoint response into a readable error.
 * `revoked` is true for invalid_grant — the stored refresh token is expired
 * or revoked (e.g. 7-day expiry while the OAuth app is in "Testing" mode, or
 * access removed in the Google Account), so retrying with it can never work
 * and the caller should drop it and ask the user to reconnect.
 */
function describeGoogleTokenError(statusCode, body) {
  const code = body?.error;
  const description = body?.error_description;

  if (code === 'invalid_grant') {
    return {
      revoked: true,
      message: 'Your Google connection has expired or been revoked (invalid_grant). Please reconnect your Google account in Settings.'
    };
  }

  if (code) {
    return {
      revoked: false,
      message: `Google token exchange failed (${code})${description ? `: ${description}` : ''}`
    };
  }

  return { revoked: false, message: `Google token exchange HTTP ${statusCode}` };
}

module.exports = { describeGoogleTokenError };
