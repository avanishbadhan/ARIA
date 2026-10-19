/**
 * Fuzzy-matches a spoken query against a list of { name, nameLower } items.
 * Extracted from SteamLibrary.findGame() so Epic/Xbox library lookups can
 * share the exact same matching algorithm instead of duplicating it.
 *
 * Exact match wins immediately; otherwise scores substring-either-direction
 * and token-overlap matches, returning the best one at or above a 0.5
 * threshold, or null.
 */
export function fuzzyMatchGameName(query, items) {
  if (!items.length) return null;

  const q = query.trim().toLowerCase()
    .replace(/['‘’]/g, "'")
    .replace(/[^a-z0-9\s':-]/g, '');

  let bestMatch = null;
  let bestScore = 0;

  for (const item of items) {
    const name = item.nameLower
      .replace(/['‘’]/g, "'")
      .replace(/[^a-z0-9\s':-]/g, '');

    if (name === q) {
      return item;
    }

    if (name.includes(q)) {
      const score = q.length / name.length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
      continue;
    }

    if (q.includes(name)) {
      const score = name.length / q.length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
      continue;
    }

    const qTokens = new Set(q.split(/\s+/).filter(t => t.length > 2));
    const nameTokens = name.split(/\s+/).filter(t => t.length > 2);
    if (qTokens.size > 0 && nameTokens.length > 0) {
      const overlap = nameTokens.filter(t => qTokens.has(t)).length;
      const score = overlap / Math.max(qTokens.size, nameTokens.length);
      if (score >= 0.5 && score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }
  }

  return bestScore >= 0.5 ? bestMatch : null;
}