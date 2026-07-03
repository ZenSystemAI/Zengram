// Pure ranking helpers for the /memory/search hot path.
//
// Final ordering blends the two retrieval signals instead of discarding fusion:
//   blended = W_SIM * similarity + W_RRF * (rrf_score / max_rrf_in_set)
// then multiplies the memory-quality signals (confidence decay, access boost,
// temporal proximity, importance). In single-path searches (no keyword hits)
// the blend collapses to the raw similarity so scores stay comparable with
// pre-fusion behavior.
//
// All knobs are env-tunable so the eval harness can A/B them without edits.

function envNumber(name, fallback) {
  const n = parseFloat(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

export const RANK_W_SIM = envNumber('RANK_W_SIM', 0.6);
export const RANK_W_RRF = envNumber('RANK_W_RRF', 0.4);

// Cap on the access-count multiplier. Uncapped, a memory read often enough
// dominates ranking, gets returned more, and reinforces itself — a popularity
// runaway. 2.0 keeps the boost meaningful without letting it swamp similarity.
export const RANK_ACCESS_BOOST_CAP = envNumber('RANK_ACCESS_BOOST_CAP', 2.0);

// Similarity stand-in for results found only by the keyword path (they have no
// vector score). Sits at the search score floor: strong enough to survive
// ranking when the RRF term backs it, never above a genuine vector match.
export const RANK_KEYWORD_ONLY_SIM = envNumber('RANK_KEYWORD_ONLY_SIM', 0.55);

export const IMPORTANCE_WEIGHTS = { critical: 1.0, high: 0.85, medium: 0.7, low: 0.5 };

export function accessBoost(accessCount) {
  const raw = 1 + 0.3 * Math.log2((accessCount || 0) + 1);
  return Math.min(raw, RANK_ACCESS_BOOST_CAP);
}

/**
 * Compute the effective ranking score for one candidate.
 *
 * @param {object} params
 * @param {number|null} params.simScore - Vector similarity in [0,1]; null when keyword-only
 * @param {number|null} params.rrfScore - RRF fusion score; null in single-path searches
 * @param {number|null} params.maxRrfScore - Highest RRF score in the fused set (normalizer)
 * @param {number} params.effectiveConfidence - Confidence after decay
 * @param {number} params.accessCount - Retrieval count for the access boost
 * @param {number} [params.temporalBoost=1.0] - Temporal proximity multiplier
 * @param {string} params.importance - critical/high/medium/low
 * @returns {number} Effective score, 4 decimal places
 */
export function effectiveScore({ simScore, rrfScore, maxRrfScore, effectiveConfidence, accessCount, temporalBoost = 1.0, importance }) {
  const sim = (simScore === null || simScore === undefined) ? RANK_KEYWORD_ONLY_SIM : simScore;
  const blended = (rrfScore != null && maxRrfScore > 0)
    ? RANK_W_SIM * sim + RANK_W_RRF * (rrfScore / maxRrfScore)
    : sim;
  const importanceWeight = IMPORTANCE_WEIGHTS[importance] ?? IMPORTANCE_WEIGHTS.medium;
  const confidence = (effectiveConfidence === null || effectiveConfidence === undefined) ? 1.0 : effectiveConfidence;
  return +(blended * confidence * accessBoost(accessCount) * temporalBoost * importanceWeight).toFixed(4);
}

/**
 * Parse a session identifier from a memory payload: metadata.session_id first,
 * then a "[Session: xxx |" content header.
 */
export function extractSessionId(payload) {
  if (payload?.metadata?.session_id) return payload.metadata.session_id;
  const text = payload?.text || '';
  const match = text.match(/\[Session:\s*(\S+)/);
  return match ? match[1] : null;
}

/**
 * Session-diversity reorder: round-robin across sessions so results span
 * unique sessions instead of clustering around the most similar one.
 *
 * Untagged items are treated as singleton sessions, so a high-relevance
 * memory without a session id competes at rank 0 alongside each session's
 * best hit instead of being appended after every tagged result.
 *
 * @param {Array} items - Sorted descending by effective_score
 * @param {(item: any) => string|null} getSessionId
 * @returns {Array} Reordered items (same objects, no mutation)
 */
export function diversifyBySession(items, getSessionId) {
  if (!Array.isArray(items) || items.length <= 3) return items;
  const perSessionRank = new Map();
  let soloCounter = 0;
  const tagged = items.map(item => {
    const sessionId = getSessionId(item) || `__solo_${soloCounter++}`;
    const rank = perSessionRank.get(sessionId) || 0;
    perSessionRank.set(sessionId, rank + 1);
    return { item, rank };
  });
  tagged.sort((a, b) => a.rank - b.rank || b.item.effective_score - a.item.effective_score);
  return tagged.map(t => t.item);
}
