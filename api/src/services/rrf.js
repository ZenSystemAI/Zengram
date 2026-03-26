// Reciprocal Rank Fusion (RRF) — merges multiple ranked result lists
// Based on: Cormack, Clarke & Buettcher (2009), "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods"
// Adapted from vectorize-io/hindsight's fusion.py

const DEFAULT_K = parseInt(process.env.RRF_K) || 60;

/**
 * Merge multiple ranked result lists using Reciprocal Rank Fusion.
 *
 * Formula: score(d) = Σ( 1 / (k + rank) )
 * where rank is 1-indexed position in each list.
 *
 * Items appearing in multiple lists get boosted. Items missing from a list
 * simply don't contribute score from that list (no penalty).
 *
 * @param {Array<Array<{id: string, source?: string}>>} rankedLists - Arrays of results, each pre-sorted by relevance
 * @param {number} [k=60] - Smoothing constant. Higher = more equal weighting across ranks. Range: 50-100 recommended.
 * @returns {Array<{id: string, rrf_score: number, sources: string[]}>} Fused results sorted by RRF score descending
 */
export function reciprocalRankFusion(rankedLists, k = DEFAULT_K) {
  if (!rankedLists || rankedLists.length === 0) return [];

  // Filter out empty lists
  const nonEmpty = rankedLists.filter(list => list && list.length > 0);
  if (nonEmpty.length === 0) return [];

  // Single list passthrough — just add scores
  if (nonEmpty.length === 1) {
    return nonEmpty[0]
      .filter(item => item && item.id)
      .map((item, rank) => ({
        id: item.id,
        rrf_score: 1 / (k + rank + 1),
        sources: [item.source || 'list_0'],
      }));
  }

  const scores = new Map(); // id → { rrf_score, sources }

  for (let listIdx = 0; listIdx < nonEmpty.length; listIdx++) {
    const list = nonEmpty[listIdx];
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      if (!item || !item.id) continue;

      const existing = scores.get(item.id);
      const rrfIncrement = 1 / (k + rank + 1); // +1 because rank is 0-indexed, formula uses 1-indexed

      if (existing) {
        existing.rrf_score += rrfIncrement;
        const src = item.source || `list_${listIdx}`;
        if (!existing.sources.includes(src)) {
          existing.sources.push(src);
        }
      } else {
        scores.set(item.id, {
          rrf_score: rrfIncrement,
          sources: [item.source || `list_${listIdx}`],
        });
      }
    }
  }

  return Array.from(scores.entries())
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => b.rrf_score - a.rrf_score);
}
