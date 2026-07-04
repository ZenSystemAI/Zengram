// Graph-boosted retrieval — reads the entity graph at search time.
//
// The write path has always maintained entities, entity_memory_links, and
// entity_relationships (co-occurrence edges with strength counts); until now
// nothing READ them during search. This module turns that graph into a third
// retrieval path alongside vector + keyword:
//
//   1. Extract entities from the query text (same dictionary/alias extractor
//      the write path uses — no LLM call, sub-millisecond).
//   2. Expand one hop over entity_relationships, weighting neighbors by
//      normalized edge strength times GRAPH_HOP_DECAY (matched entities score
//      1.0; a neighbor can never outrank a direct match).
//   3. Collect memories linked to any of those entities, scored by the sum of
//      their entities' scores, and hand the ranked list to RRF as a weighted
//      third list (RRF_GRAPH_WEIGHT).
//
// Gated by GRAPH_RETRIEVAL_ENABLED (default off → zero behaviour change).
// A single plain-CTE query serves the whole expansion; the strength-DESC
// partial indexes on entity_relationships keep the neighbor scan cheap.

import { extractEntities } from './entities.js';
import { _getStoreInstance, isEntityStoreAvailable } from './stores/interface.js';

export const GRAPH_RETRIEVAL_ENABLED = process.env.GRAPH_RETRIEVAL_ENABLED === 'true';

// Fusion weight for the graph list. Graph co-occurrence is a weaker relevance
// signal than semantic similarity or exact keyword match, so it defaults to
// half their weight — enough to surface associatively-related memories without
// letting hub entities dominate.
export function rrfGraphWeight() {
  const w = parseFloat(process.env.RRF_GRAPH_WEIGHT);
  return Number.isFinite(w) && w >= 0 ? w : 0.5;
}

// Score multiplier for 1-hop neighbors relative to directly-matched entities.
const HOP_DECAY = (() => {
  const d = parseFloat(process.env.GRAPH_HOP_DECAY);
  return Number.isFinite(d) && d >= 0 && d <= 1 ? d : 0.5;
})();

// Cap on expanded neighbor edges per query — bounds the blast radius of hub
// entities (an entity linked to everything would otherwise pull in the world).
const NEIGHBOR_LIMIT = (() => {
  const n = parseInt(process.env.GRAPH_NEIGHBOR_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 12;
})();

/**
 * Entity names extracted from a query, lowercased and deduped.
 * Exported for testability — pure wrapper over the shared extractor.
 */
export function queryEntityNames(queryText) {
  if (!queryText || typeof queryText !== 'string') return [];
  // No clientId/sourceAgent: those would seed the client/agent entity itself,
  // which links to nearly every memory in scope — pure noise for ranking.
  const entities = extractEntities(queryText);
  return [...new Set(entities.map(e => String(e.name || '').toLowerCase()).filter(Boolean))];
}

/**
 * Rank memories by entity-graph proximity to the query.
 *
 * @param {string} queryText - Raw user query (NOT the expanded query — expansion
 *   adds domain synonyms that would seed unrelated entities)
 * @param {object} [opts]
 * @param {string} [opts.clientId] - Tenant scope; omitted = no client filter
 * @param {string} [opts.type] - Memory type filter
 * @param {number} [opts.limit=40] - Max memories returned
 * @returns {Promise<Array<{id: string, graph_score: number, via: string[]}>>}
 *   Sorted descending by graph_score. Empty when the graph store is
 *   unavailable, the query names no known entities, or on any error (the
 *   graph path is additive — it must never break search).
 */
export async function graphCandidates(queryText, { clientId, type, limit = 40 } = {}) {
  if (!GRAPH_RETRIEVAL_ENABLED || !isEntityStoreAvailable()) return [];

  const names = queryEntityNames(queryText);
  if (names.length === 0) return [];

  const store = _getStoreInstance();
  try {
    const result = await store.pool.query(
      `WITH matched AS (
         SELECT e.id, 1.0::float AS escore
           FROM entities e
          WHERE LOWER(e.canonical_name) = ANY($1)
         UNION
         SELECT a.entity_id AS id, 1.0::float AS escore
           FROM entity_aliases a
          WHERE LOWER(a.alias) = ANY($1)
       ),
       neighbor_edges AS (
         SELECT CASE WHEN m.id = r.source_entity_id
                     THEN r.target_entity_id
                     ELSE r.source_entity_id END AS id,
                r.strength
           FROM entity_relationships r
           JOIN matched m
             ON m.id = r.source_entity_id OR m.id = r.target_entity_id
          WHERE r.source_entity_id IS NOT NULL
            AND r.target_entity_id IS NOT NULL
          ORDER BY r.strength DESC
          LIMIT $2
       ),
       neighbors AS (
         SELECT ne.id,
                $3::float * MAX(ne.strength)::float
                  / GREATEST((SELECT MAX(strength) FROM neighbor_edges), 1) AS escore
           FROM neighbor_edges ne
          WHERE ne.id NOT IN (SELECT id FROM matched)
          GROUP BY ne.id
       ),
       all_entities AS (
         SELECT id, MAX(escore) AS escore
           FROM (SELECT * FROM matched UNION ALL SELECT * FROM neighbors) u
          GROUP BY id
       )
       SELECT l.memory_id AS id,
              SUM(ae.escore)::float AS graph_score,
              ARRAY_AGG(DISTINCT e.canonical_name) AS via
         FROM entity_memory_links l
         JOIN all_entities ae ON ae.id = l.entity_id
         JOIN entities e ON e.id = ae.id
         JOIN memory_search ms ON ms.memory_id = l.memory_id
        WHERE ms.active = true
          AND ($4::text IS NULL OR ms.client_id = $4)
          AND ($5::text IS NULL OR ms.type = $5)
        GROUP BY l.memory_id
        ORDER BY graph_score DESC
        LIMIT $6`,
      [names, NEIGHBOR_LIMIT, HOP_DECAY, clientId || null, type || null, limit]
    );
    return result.rows;
  } catch (e) {
    console.error('[graph-retrieval] expansion failed; continuing without graph path:', e.message);
    return [];
  }
}
