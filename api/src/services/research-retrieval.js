// Shared multi-path retrieval used by both /reflect (single-shot synthesis) and
// /research (iterate-until-sufficient). Lifted verbatim from the inline block in
// routes/reflect.js so the two routes share one battle-tested retrieval path:
// vector + keyword in parallel, RRF fusion, getPoints backfill, and a graceful
// keyword fallback when the vector path is unavailable.

import { embed } from './embedders/interface.js';
import { getPoints, searchPoints } from './pgvector.js';
import { isKeywordSearchAvailable, keywordSearch } from './keyword-search.js';
import { reciprocalRankFusion, rrfWeights } from './rrf.js';
import { isRerankAvailable, rerankMemories } from './reranker/interface.js';
import { extractSearchTerms } from './query-expander.js';

const MULTI_PATH_SEARCH = process.env.MULTI_PATH_SEARCH !== 'false';

// When reranking is on, fuse a larger candidate pool (precision comes from the
// cross-encoder, not the fused order), then rerank down to maxMemories.
const RERANK_POOL = parseInt(process.env.RERANK_CANDIDATES) || 40;

const escapeXml = (str) => String(str ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Render retrieved memories as the `<memory id=..>` XML block the LLM prompts expect.
 * Shared so reflect and research present memories identically (and the `id=` attribute
 * is what per-claim `[mem:<id>]` citations reference).
 * @param {Array<{id: string, payload: object}>} memories
 * @returns {string}
 */
export function formatMemoriesXml(memories) {
  return memories.map(m => {
    const p = m.payload || {};
    return `<memory id="${escapeXml(m.id)}" type="${escapeXml(p.type)}" agent="${escapeXml(p.source_agent || '')}" client="${escapeXml(p.client_id || '')}" created="${escapeXml(p.created_at)}">\n${escapeXml(p.text || '')}\n</memory>`;
  }).join('\n\n');
}

/**
 * Multi-path retrieve + fuse for a single query.
 *
 * Behaviour is identical to the block previously inlined in routes/reflect.js:
 *  - vector (embed→searchPoints) and keyword (full-text) run in parallel
 *  - results fuse via Reciprocal Rank Fusion, with getPoints backfilling
 *    keyword-only hits that have no vector payload
 *  - if the vector path fails AND keyword returned nothing, retry keyword with
 *    broader extracted terms (the degraded fallback)
 *
 * @param {object} opts
 * @param {string} opts.queryText        Natural-language query.
 * @param {object} [opts.filter]         Search filter (e.g. { active: true, client_id }).
 * @param {number} opts.maxMemories      Max fused memories to return.
 * @param {boolean} [opts.multiPath]     Override MULTI_PATH_SEARCH (defaults to env).
 * @returns {Promise<{memories: Array, vectorError: Error|null, keywordCount: number, degradedKeywordQuery: string|null}>}
 */
export async function retrieveAndFuse({ queryText, filter = { active: true }, maxMemories, multiPath = MULTI_PATH_SEARCH }) {
  const rerankOn = isRerankAvailable();
  // With reranking on, keep a deeper candidate pool so the cross-encoder has
  // real material to re-order; without it, behaviour is unchanged.
  const poolSize = rerankOn ? Math.max(maxMemories, RERANK_POOL) : maxMemories;
  const fetchLimit = multiPath ? Math.min(Math.max(maxMemories * 2, poolSize), 50) : maxMemories;

  let vectorError = null;
  const vectorPromise = embed(queryText, 'search')
    .then(vector => searchPoints(vector, filter, fetchLimit))
    .catch(e => {
      vectorError = e;
      console.warn('[retrieve] Vector path unavailable; attempting keyword fallback:', e.message);
      return [];
    });

  const keywordPromise = (multiPath && isKeywordSearchAvailable())
    ? keywordSearch(queryText, filter, fetchLimit).catch(e => {
        console.error('[retrieve:keyword-search]', e.message);
        return [];
      })
    : Promise.resolve([]);

  let [vectorResults, keywordResults] = await Promise.all([vectorPromise, keywordPromise]);
  let degradedKeywordQuery = null;

  if (vectorError && multiPath && keywordResults.length === 0 && isKeywordSearchAvailable()) {
    const broader = extractSearchTerms(queryText);
    if (broader && broader.length > 3 && broader !== queryText.toLowerCase()) {
      degradedKeywordQuery = broader;
      keywordResults = await keywordSearch(broader, filter, fetchLimit).catch(e => {
        console.error('[retrieve:keyword-search:fallback]', e.message);
        return [];
      });
    }
  }

  let memories;
  if (multiPath && keywordResults.length > 0) {
    const rankedLists = [
      vectorResults.map(r => ({ id: r.id, source: 'vector' })),
      keywordResults.map(r => ({ id: r.memory_id, source: 'keyword' })),
    ];

    const fused = reciprocalRankFusion(rankedLists, undefined, rrfWeights()).slice(0, poolSize);
    const payloadMap = new Map(vectorResults.map(r => [r.id, r]));

    const missingIds = fused.map(f => f.id).filter(id => !payloadMap.has(id));
    if (missingIds.length > 0) {
      try {
        const fetched = await getPoints(missingIds);
        for (const pt of fetched) {
          payloadMap.set(pt.id, { id: pt.id, score: 0, payload: pt.payload });
        }
      } catch (e) {
        console.error('[retrieve] Batch fetch failed:', e.message);
      }
    }

    memories = fused.map(f => payloadMap.get(f.id)).filter(Boolean);
  } else {
    memories = vectorResults.slice(0, poolSize);
  }

  // Cross-encoder rerank the candidate pool, then trim to the requested count.
  // No-op (identity) when reranking is disabled or unavailable.
  if (rerankOn && memories.length > 1) {
    memories = await rerankMemories(queryText, memories, { topN: maxMemories });
  } else {
    memories = memories.slice(0, maxMemories);
  }

  return { memories, vectorError, keywordCount: keywordResults.length, degradedKeywordQuery };
}
