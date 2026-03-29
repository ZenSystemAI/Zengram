// Relevance scoring for incoming memories.
// Runs inline at store time (<5ms target). No LLM calls, no extra embedding calls.
// Scores are advisory — they annotate memories but never block storage.

import { searchPoints } from './qdrant.js';

// Score thresholds
const SCORE_NORMAL = 0.7;
const SCORE_FLAGGED = 0.4;

// Near-duplicate detection (uses the vector already computed for storage)
const NEAR_DUPLICATE_THRESHOLD = 0.85;
const NEAR_DUPLICATE_PENALTY = 0.3;

// Content length scoring
const MIN_CONTENT_LENGTH = 20;
const MAX_CONTENT_LENGTH = 5000;

// --- Source Trust Cache ---
// Cached aggregate: agent → { total_accesses, total_memories, trust_score }
// Refreshed periodically via feedback loop; starts empty (all agents trusted equally).
const sourceTrustCache = new Map();

export function updateSourceTrust(agentStats) {
  for (const [agent, stats] of Object.entries(agentStats)) {
    sourceTrustCache.set(agent, stats);
  }
}

export function getSourceTrust(agent) {
  return sourceTrustCache.get(agent)?.trust_score ?? 0.5;
}

/**
 * Score an incoming memory for relevance.
 * Called after entity extraction and embedding, before Qdrant upsert.
 *
 * @param {object} params
 * @param {string} params.content - Cleaned content text
 * @param {string} params.type - Memory type (event, fact, decision, status)
 * @param {string} params.importance - Declared importance
 * @param {string} params.source_agent - Agent storing the memory
 * @param {Array} params.entities - Extracted entities array
 * @param {number[]} params.vector - Already-computed embedding vector
 * @param {string} params.client_id - Client scope
 * @returns {Promise<{score: number, signals: object, classification: string}>}
 */
export async function scoreRelevance({ content, type, importance, source_agent, entities, vector, client_id }) {
  const signals = {};
  let score = 0.5; // Start neutral

  // 1. Content length
  const len = content.length;
  if (len < MIN_CONTENT_LENGTH) {
    signals.content_length = 'too_short';
    score -= 0.2;
  } else if (len > MAX_CONTENT_LENGTH) {
    signals.content_length = 'very_long';
    score -= 0.05; // Mild penalty — long content can still be valuable
  } else {
    signals.content_length = 'ok';
    score += 0.1;
  }

  // 2. Entity density — memories mentioning known entities are more useful
  const entityCount = (entities || []).length;
  if (entityCount >= 3) {
    signals.entity_density = 'high';
    score += 0.15;
  } else if (entityCount >= 1) {
    signals.entity_density = 'medium';
    score += 0.08;
  } else {
    signals.entity_density = 'none';
    // No penalty — not all memories need entities
  }

  // 3. Importance alignment
  const importanceBoost = { critical: 0.2, high: 0.1, medium: 0, low: -0.1 };
  const impBoost = importanceBoost[importance] || 0;
  signals.importance = importance || 'medium';
  score += impBoost;

  // 4. Source trust — agents with historically useful memories get a boost
  const trust = getSourceTrust(source_agent);
  signals.source_trust = +trust.toFixed(2);
  score += (trust - 0.5) * 0.2; // Range: -0.1 to +0.1

  // 5. Type bonus — facts and decisions are inherently more durable
  if (type === 'fact' || type === 'decision') {
    signals.type_bonus = true;
    score += 0.05;
  }

  // 6. Near-duplicate check (uses the already-computed vector — no extra embed call)
  // Quick vector search: find the closest existing memory
  try {
    const filter = { active: true };
    if (client_id) filter.client_id = client_id;
    const nearest = await searchPoints(vector, filter, 1);
    if (nearest.length > 0 && nearest[0].score > NEAR_DUPLICATE_THRESHOLD) {
      signals.near_duplicate = {
        similarity: +nearest[0].score.toFixed(4),
        existing_id: nearest[0].id,
      };
      score -= NEAR_DUPLICATE_PENALTY;
    } else {
      signals.near_duplicate = false;
    }
  } catch (e) {
    // Non-blocking — skip near-duplicate check if Qdrant is slow
    signals.near_duplicate = 'skipped';
  }

  // Clamp score to [0, 1]
  score = Math.max(0, Math.min(1, score));

  // Classify
  let classification;
  if (score >= SCORE_NORMAL) {
    classification = 'normal';
  } else if (score >= SCORE_FLAGGED) {
    classification = 'flagged';
  } else {
    classification = 'deprioritized';
  }

  return {
    score: +score.toFixed(4),
    signals,
    classification,
  };
}

/**
 * Build payload fields for the relevance score.
 * Returns object to spread into the Qdrant payload.
 */
export function relevancePayloadFields(result) {
  return {
    relevance_score: result.score,
    auto_flagged: result.classification === 'flagged',
    auto_deprioritized: result.classification === 'deprioritized',
  };
}
