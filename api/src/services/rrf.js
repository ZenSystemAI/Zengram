// Reciprocal Rank Fusion (RRF) — merges multiple ranked result lists
// Based on: Cormack, Clarke & Buettcher (2009), "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods"
// Adapted from vectorize-io/hindsight's fusion.py

const DEFAULT_K = parseInt(process.env.RRF_K) || 60;

// Per-source weights for the standard [vector, keyword] fusion order. Default
// 1/1 (vanilla RRF). Tune to bias toward semantic (vector) or exact (keyword)
// matches — A/B with the eval harness before changing in production.
export function rrfWeights() {
  const v = parseFloat(process.env.RRF_VECTOR_WEIGHT);
  const kw = parseFloat(process.env.RRF_KEYWORD_WEIGHT);
  return [Number.isFinite(v) && v >= 0 ? v : 1, Number.isFinite(kw) && kw >= 0 ? kw : 1];
}

/**
 * Merge multiple ranked result lists using Reciprocal Rank Fusion.
 *
 * Formula: score(d) = Σ( weight_list / (k + rank) )
 * where rank is 1-indexed position in each list.
 *
 * Items appearing in multiple lists get boosted. Items missing from a list
 * simply don't contribute score from that list (no penalty).
 *
 * Optional per-list `weights` implement Weighted RRF: each list's contribution
 * is scaled by its weight, letting one retrieval path (e.g. vector) count more
 * than another (e.g. keyword) without changing rank order within a list.
 * Weights default to 1.0 → identical to vanilla RRF. Weights align to the
 * ORIGINAL rankedLists order (empty lists are skipped but indices preserved).
 *
 * @param {Array<Array<{id: string, source?: string}>>} rankedLists - Arrays of results, each pre-sorted by relevance
 * @param {number} [k=60] - Smoothing constant. Higher = more equal weighting across ranks. Range: 50-100 recommended.
 * @param {number[]} [weights] - Per-list multipliers aligned to rankedLists (default: all 1.0).
 * @returns {Array<{id: string, rrf_score: number, sources: string[]}>} Fused results sorted by RRF score descending
 */
export function reciprocalRankFusion(rankedLists, k = DEFAULT_K, weights = null) {
  if (!rankedLists || rankedLists.length === 0) return [];

  const weightFor = (origIdx) => {
    const w = weights && Number.isFinite(weights[origIdx]) ? weights[origIdx] : 1;
    return w >= 0 ? w : 1;
  };

  const scores = new Map(); // id → { rrf_score, sources }
  let nonEmptyCount = 0;

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list = rankedLists[listIdx];
    if (!list || list.length === 0) continue;
    nonEmptyCount++;
    const weight = weightFor(listIdx);

    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      if (!item || !item.id) continue;

      const existing = scores.get(item.id);
      const rrfIncrement = weight / (k + rank + 1); // +1 because rank is 0-indexed, formula uses 1-indexed
      const src = item.source || `list_${listIdx}`;

      if (existing) {
        existing.rrf_score += rrfIncrement;
        if (!existing.sources.includes(src)) {
          existing.sources.push(src);
        }
      } else {
        scores.set(item.id, {
          rrf_score: rrfIncrement,
          sources: [src],
        });
      }
    }
  }

  if (nonEmptyCount === 0) return [];

  return Array.from(scores.entries())
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => b.rrf_score - a.rrf_score);
}
