// Feedback loop: learns from memory access patterns to improve relevance scoring.
// Runs periodically (alongside consolidation cron) — NOT on every request.
//
// Two jobs:
// 1. Compute source trust scores (which agents produce frequently-accessed memories)
// 2. Auto-deprioritize stale memories (zero access after N days)

import { scrollPoints, updatePointPayload } from './qdrant.js';
import { updateSourceTrust } from './relevance-scorer.js';

const STALE_DAYS = parseInt(process.env.AUTO_DEPRIORITIZE_DAYS) || 30;
const STALE_IMPORTANCE_EXEMPT = ['critical', 'high']; // Never auto-deprioritize these

/**
 * Run the feedback loop. Call on a schedule (e.g., every 6 hours with consolidation).
 * @returns {Promise<{agents_scored: number, stale_deprioritized: number}>}
 */
export async function runFeedbackLoop() {
  const startTime = Date.now();
  console.log('[feedback-loop] Starting...');

  // --- Phase 1: Compute source trust scores ---
  const agentStats = {};
  let offset = null;
  let scanned = 0;

  do {
    const result = await scrollPoints({ active: true }, 200, offset);
    const points = result.points || [];

    for (const point of points) {
      const p = point.payload;
      const agent = p.source_agent;
      if (!agent) continue;

      if (!agentStats[agent]) {
        agentStats[agent] = { total_memories: 0, total_accesses: 0 };
      }
      agentStats[agent].total_memories++;
      agentStats[agent].total_accesses += (p.access_count || 0);
    }

    scanned += points.length;
    offset = result.next_page_offset || null;

    // Safety cap: don't scroll the entire collection in one run
    if (scanned > 10000) break;
  } while (offset);

  // Compute trust score: access_rate = total_accesses / total_memories
  // Normalize to [0, 1] range relative to the best-performing agent
  let maxRate = 0;
  for (const stats of Object.values(agentStats)) {
    stats.access_rate = stats.total_memories > 0 ? stats.total_accesses / stats.total_memories : 0;
    maxRate = Math.max(maxRate, stats.access_rate);
  }

  for (const stats of Object.values(agentStats)) {
    stats.trust_score = maxRate > 0 ? 0.3 + 0.7 * (stats.access_rate / maxRate) : 0.5;
  }

  updateSourceTrust(agentStats);
  console.log(`[feedback-loop] Source trust updated for ${Object.keys(agentStats).length} agents (scanned ${scanned} memories)`);

  // --- Phase 2: Auto-deprioritize stale memories ---
  let deprioritized = 0;
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();
  offset = null;

  do {
    const result = await scrollPoints({ active: true }, 100, offset);
    const points = result.points || [];

    for (const point of points) {
      const p = point.payload;

      // Skip already deprioritized
      if (p.auto_deprioritized) continue;

      // Skip high-importance
      if (STALE_IMPORTANCE_EXEMPT.includes(p.importance)) continue;

      // Skip types that don't decay (events, decisions are historical)
      if (p.type === 'event' || p.type === 'decision') continue;

      // Check: zero accesses AND created before cutoff
      if ((p.access_count || 0) === 0 && p.created_at && p.created_at < cutoff) {
        try {
          await updatePointPayload(point.id, {
            auto_deprioritized: true,
            deprioritized_at: new Date().toISOString(),
            deprioritized_reason: `Zero accesses after ${STALE_DAYS} days`,
          });
          deprioritized++;
        } catch (e) {
          // Non-blocking
        }
      }
    }

    offset = result.next_page_offset || null;

    // Safety cap
    if (deprioritized > 500) break;
  } while (offset);

  const duration = Date.now() - startTime;
  console.log(`[feedback-loop] Complete: ${Object.keys(agentStats).length} agents scored, ${deprioritized} stale memories deprioritized (${duration}ms)`);

  return {
    agents_scored: Object.keys(agentStats).length,
    agent_details: agentStats,
    stale_deprioritized: deprioritized,
    duration_ms: duration,
  };
}
