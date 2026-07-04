// Reranker interface — an optional cross-encoder stage that re-scores the
// fused (vector + full-text/RRF) candidate set by true query↔document relevance.
//
// This is the single highest-leverage retrieval improvement: dense + keyword
// give good RECALL into a candidate pool, but a cross-encoder gives far better
// PRECISION at the top by reading query and document together (no single-vector
// bottleneck). It runs only over the small fused candidate set (top ~20-50),
// so latency is bounded.
//
// Gated by RERANK_ENABLED (default off → zero behaviour change). When enabled,
// callers pass the fused candidates through rerankMemories(); the returned
// rerank score replaces the upstream similarity/RRF blend that feeds the
// existing decay/access/importance weighting, so all downstream behaviour is
// preserved.
//
// Provider-agnostic, mirrors embedders/ and llm/. Each provider implements:
//   rerank(query, documents:string[], topN?) → Array<{index:number, score:number}>

const ENABLED = process.env.RERANK_ENABLED === 'true';

let provider = null;
let initialized = false;

export function isRerankEnabled() {
  return ENABLED;
}

export async function initReranker() {
  if (!ENABLED) {
    console.log('[reranker] Disabled (set RERANK_ENABLED=true to enable)');
    return;
  }
  const kind = (process.env.RERANK_PROVIDER || 'http').toLowerCase();
  switch (kind) {
    case 'http':
    case 'tei':
    case 'infinity':
    case 'jina':
    case 'cohere': {
      const { HttpReranker } = await import('./http.js');
      provider = new HttpReranker();
      break;
    }
    default:
      throw new Error(`Unknown reranker provider: ${kind}. Use: http (TEI/Infinity/Jina/Cohere-compatible /rerank)`);
  }

  // Validate with a trivial probe so a misconfigured endpoint fails loudly at
  // startup rather than silently degrading every search.
  try {
    const probe = await provider.rerank('healthcheck', ['healthcheck document', 'unrelated document'], 2);
    if (!Array.isArray(probe)) throw new Error('rerank returned non-array');
    initialized = true;
    console.log(`[reranker] Provider: ${provider.info()} (candidate pool → cross-encoder rerank)`);
  } catch (e) {
    // Don't hard-crash the whole API over a reranker outage — log and stay
    // disabled so search still works (degrades to fused-RRF order).
    provider = null;
    console.error(`[reranker] Init/probe failed; reranking disabled for now: ${e.message}`);
  }
}

export function isRerankAvailable() {
  return ENABLED && initialized && provider !== null;
}

/**
 * Rerank a candidate set of memories by query relevance.
 * Falls back to the input order (identity) on any error or when disabled, so a
 * reranker outage can never make search worse than the fused baseline.
 *
 * @param {string} query
 * @param {Array<{id:string, payload?:object}>} candidates  fused candidates (payloads present)
 * @param {object} [opts]
 * @param {number} [opts.topN]  return at most this many (default: all candidates)
 * @param {(c:object)=>string} [opts.textOf]  how to extract the document text
 * @returns {Promise<Array<{id, payload, rerank_score:number|null}>>}
 */
export async function rerankMemories(query, candidates, opts = {}) {
  const { topN, textOf } = opts;
  if (!isRerankAvailable() || !Array.isArray(candidates) || candidates.length === 0) {
    return candidates.map(c => ({ ...c, rerank_score: null }));
  }
  const getText = textOf || ((c) => (c.payload?.text || c.payload?.content || ''));
  const documents = candidates.map(getText);

  try {
    const scored = await provider.rerank(query, documents, topN || candidates.length);
    // scored: [{index, score}] referencing positions in `documents`
    const byIndex = new Map(scored.map(s => [s.index, s.score]));
    const out = candidates.map((c, i) => ({
      ...c,
      rerank_score: byIndex.has(i) ? byIndex.get(i) : null,
    }));
    // Sort by rerank score desc; candidates the reranker dropped (no score) sink
    // to the bottom but keep their relative fused order.
    out.sort((a, b) => {
      if (a.rerank_score == null && b.rerank_score == null) return 0;
      if (a.rerank_score == null) return 1;
      if (b.rerank_score == null) return -1;
      return b.rerank_score - a.rerank_score;
    });
    return topN ? out.slice(0, topN) : out;
  } catch (e) {
    console.error('[reranker] rerank failed; falling back to fused order:', e.message);
    return candidates.map(c => ({ ...c, rerank_score: null }));
  }
}

export function getRerankerInfo() {
  return {
    enabled: ENABLED,
    available: isRerankAvailable(),
    provider: provider ? provider.info() : null,
  };
}
