// Lives here (not in src/) because electron-builder's `files` config only
// packages electron/**/* and dist/**/* — src/ never ships, so main.cjs can't
// require anything from it at runtime after packaging.

function parseVersion(version) {
  const [major, minor, patch] = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  return { major, minor, patch };
}

/**
 * Compares a candidate version against the currently running version.
 * Returns 'major' | 'minor' | 'none'. 'minor' covers both minor and patch
 * bumps — auto-update only auto-downloads for 'major'.
 */
function classifyUpdate(currentVersion, latestVersion) {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);

  const isNewer =
    latest.major > current.major ||
    (latest.major === current.major && latest.minor > current.minor) ||
    (latest.major === current.major && latest.minor === current.minor && latest.patch > current.patch);

  if (!isNewer) return 'none';
  return latest.major > current.major ? 'major' : 'minor';
}

module.exports = { classifyUpdate, parseVersion };
