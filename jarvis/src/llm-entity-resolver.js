/**
 * Asks the LLM to pick the real target the user most likely meant, given a
 * possibly-mangled transcript and the actual list of valid candidates.
 * Grounded strictly: the LLM may only return one of the provided candidate
 * strings verbatim, or the literal string "NONE" — anything else (including
 * a plausible-sounding title that isn't actually in the list) is treated as
 * no match. This is what makes the fallback safe to always run: it can never
 * launch something that doesn't exist, only fail to find something that does.
 */
export async function resolveWithLlmFallback({ query, alternatives = [], candidates, kind, resolveEntity, onLog = () => {} }) {
  if (!resolveEntity || !candidates || !candidates.length) return null;

  onLog({ type: 'HARNESS', message: `[LLM ENTITY RESOLVER] Fast match missed for "${query}" (${kind}) — asking the LLM to pick from ${candidates.length} candidate(s).` });

  let picked;
  try {
    picked = await resolveEntity({ query, alternatives, candidates: candidates.map(c => c.name), kind });
  } catch (e) {
    onLog({ type: 'WARNING', message: `[LLM ENTITY RESOLVER] ${e.message}` });
    return null;
  }

  if (!picked) {
    onLog({ type: 'WARNING', message: `[LLM ENTITY RESOLVER] No LLM provider available (no API key configured) — skipping.` });
    return null;
  }

  if (picked.trim().toUpperCase() === 'NONE') {
    onLog({ type: 'WARNING', message: `[LLM ENTITY RESOLVER] Model found no plausible match for "${query}" among the candidates.` });
    return null;
  }

  const normalized = picked.trim().toLowerCase();
  const match = candidates.find(c => c.name.trim().toLowerCase() === normalized);

  if (match) {
    onLog({ type: 'SUCCESS', message: `[LLM ENTITY RESOLVER] "${query}" -> "${match.name}" (${kind})` });
  } else {
    onLog({ type: 'WARNING', message: `[LLM ENTITY RESOLVER] Model returned "${picked}", not in candidate list — discarding.` });
  }

  return match || null;
}
