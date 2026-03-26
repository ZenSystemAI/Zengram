// BFS Spreading Activation Graph Retrieval
// Uses existing entity graph (entities, entity_relationships, entity_memory_links)
// to find related memories via entity connections.
//
// Inspired by vectorize-io/hindsight's BFSGraphRetriever.

import { extractEntities } from './entities.js';
import { isEntityStoreAvailable, findEntity, getRelationships, getEntityMemories } from './stores/interface.js';

const MAX_DEPTH = parseInt(process.env.GRAPH_SEARCH_MAX_DEPTH) || 2;
const DECAY = parseFloat(process.env.GRAPH_SEARCH_DECAY) || 0.8;
const CAUSAL_BOOST = parseFloat(process.env.GRAPH_SEARCH_CAUSAL_BOOST) || 2.0;
const MIN_ACTIVATION = 0.1;

// Relationship types that get causal boost (typed, meaningful connections)
const BOOSTED_TYPES = new Set(['uses', 'works_on', 'contact_of', 'same_owner', 'competitor_of']);

export function isGraphSearchAvailable() {
  return isEntityStoreAvailable();
}

/**
 * Graph-based retrieval: extract entities from query, BFS through entity graph,
 * collect memory IDs associated with activated entities.
 *
 * @param {string} queryText - Natural language query
 * @param {object} filters - { client_id, type }
 * @param {number} limit - Max memory IDs to return
 * @returns {Promise<Array<{memory_id: string, activation_score: number}>>}
 */
export async function graphSearch(queryText, filters = {}, limit = 20) {
  if (!isGraphSearchAvailable()) return [];
  if (!queryText || queryText.trim().length === 0) return [];

  // Step 1: Extract entities from query text (fast path — regex, sub-ms)
  const queryEntities = extractEntities(queryText, filters.client_id || 'global', 'graph-search');
  if (queryEntities.length === 0) return [];

  // Step 2: Resolve entity IDs from the store
  const seedEntities = [];
  for (const ent of queryEntities) {
    try {
      const found = await findEntity(ent.name);
      if (found) {
        seedEntities.push({ id: found.id, name: found.canonical_name, activation: 1.0 });
      }
    } catch (_) { /* entity not in graph — skip */ }
  }

  if (seedEntities.length === 0) return [];

  // Step 3: BFS spreading activation
  const activated = new Map(); // entityId → activation score
  const queue = seedEntities.map(e => ({ id: e.id, activation: e.activation, depth: 0 }));

  while (queue.length > 0) {
    const { id, activation, depth } = queue.shift();

    // Skip if we've seen this entity with equal or better activation
    if (activated.has(id) && activated.get(id) >= activation) continue;
    activated.set(id, activation);

    // Don't expand beyond max depth
    if (depth >= MAX_DEPTH) continue;

    // Get relationships for this entity
    try {
      const relationships = await getRelationships(id, 1);
      for (const rel of relationships) {
        const isBoosted = BOOSTED_TYPES.has(rel.relationship_type);
        const strengthFactor = Math.min(rel.strength / 5, 1.0); // normalize strength to 0-1

        const nextActivation = activation * DECAY
          * (isBoosted ? CAUSAL_BOOST : 1.0)
          * strengthFactor;

        if (nextActivation < MIN_ACTIVATION) continue;

        queue.push({
          id: rel.entity.id,
          activation: nextActivation,
          depth: depth + 1,
        });
      }
    } catch (_) { /* relationship lookup failed — skip this node */ }
  }

  // Step 4: Collect memory IDs from all activated entities
  const memoryScores = new Map(); // memory_id → aggregate activation score

  for (const [entityId, activation] of activated.entries()) {
    try {
      const memories = await getEntityMemories(entityId, 50);
      if (memories && memories.results) {
        for (const link of memories.results) {
          const existing = memoryScores.get(link.memory_id) || 0;
          memoryScores.set(link.memory_id, existing + activation);
        }
      }
    } catch (_) { /* memory lookup failed — skip */ }
  }

  // Step 5: Sort by aggregate activation and return top N
  return Array.from(memoryScores.entries())
    .map(([memory_id, activation_score]) => ({ memory_id, activation_score }))
    .sort((a, b) => b.activation_score - a.activation_score)
    .slice(0, limit);
}
