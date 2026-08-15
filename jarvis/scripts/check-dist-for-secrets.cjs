/**
 * Fails the build if the compiled dist/ bundle contains anything shaped like
 * a real API key. Runs after `vite build`, before electron-builder packages
 * dist/ into a distributable installer.
 *
 * Why this exists: Vite inlines import.meta.env.VITE_* values as literal
 * strings at build time. A real secret sitting in a developer's local .env
 * for a build-time-only, non-VITE_ purpose is safe — but if any code ever
 * reads a secret via import.meta.env.VITE_*, that value gets baked directly
 * into the shipped JS and goes out to every user who downloads the app.
 * (This exact mistake shipped a Steam/Deepgram/OpenRouter API key in the
 * v1.4.0 release — see the git history around 4c61424.) The fix at the code
 * level was removing every such fallback; this script is the second line of
 * defense so a future regression fails the build instead of shipping.
 */
const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, '..', 'dist');

const SECRET_PATTERNS = [
  { name: 'OpenRouter API key', regex: /sk-or-v1-[A-Za-z0-9_-]{10,}/g },
  { name: 'Groq API key', regex: /gsk_[A-Za-z0-9_-]{10,}/g },
  { name: 'Steam/Deepgram/Spotify-shaped hex secret (32-40 hex chars)', regex: /\b[A-Fa-f0-9]{32,40}\b/g }
];

function redact(match) {
  if (match.length <= 8) return '*'.repeat(match.length);
  return `${match.slice(0, 4)}${'*'.repeat(match.length - 8)}${match.slice(-4)}`;
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walk(fullPath));
    } else if (/\.(js|mjs|cjs|html|css)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

if (!fs.existsSync(DIST_DIR)) {
  console.error(`[check-dist-for-secrets] dist/ not found at ${DIST_DIR} — did vite build run first?`);
  process.exit(1);
}

const findings = [];
for (const file of walk(DIST_DIR)) {
  const content = fs.readFileSync(file, 'utf8');
  for (const { name, regex } of SECRET_PATTERNS) {
    for (const match of content.matchAll(regex)) {
      findings.push({ file: path.relative(DIST_DIR, file), name, redacted: redact(match[0]) });
    }
  }
}

if (findings.length > 0) {
  console.error('\n[check-dist-for-secrets] BLOCKED — the built bundle contains what looks like a real secret:\n');
  for (const f of findings) {
    console.error(`  ${f.file}: ${f.name} (${f.redacted})`);
  }
  console.error('\nThis usually means some code reads a secret via import.meta.env.VITE_* — Vite');
  console.error('inlines those as literal strings at build time, and this bundle would ship them');
  console.error('to every user. Read the secret from localStorage (Settings UI) instead, never');
  console.error('from import.meta.env.VITE_* for anything sensitive. Build blocked.\n');
  process.exit(1);
}

console.log('[check-dist-for-secrets] OK — no secret-shaped strings found in dist/.');
