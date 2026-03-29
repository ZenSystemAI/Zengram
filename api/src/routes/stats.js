import { Router } from 'express';
import { getMemoryStats, scrollPoints, computeEffectiveConfidence, DECAY_TYPES } from '../services/qdrant.js';
import { isEntityStoreAvailable, getEntityStats } from '../services/stores/interface.js';
import { isKeywordSearchAvailable, getKeywordIndexCount } from '../services/keyword-search.js';
import { isGraphSearchAvailable } from '../services/graph-search.js';

export const statsRouter = Router();

// GET /memory/stats — Memory health dashboard
statsRouter.get('/', async (req, res) => {
  try {
    const stats = await getMemoryStats();

    // Sample decayed memories (facts/statuses with low effective confidence)
    let decayedCount = 0;
    try {
      const recentFacts = await scrollPoints({ type: 'fact' }, 100);
      const points = recentFacts.points || [];
      for (const point of points) {
        const eff = computeEffectiveConfidence(point.payload);
        if (eff < 0.5) decayedCount++;
      }
    } catch (e) {
      // Non-critical
    }

    // Entity stats
    let entityStats = null;
    if (isEntityStoreAvailable()) {
      try {
        entityStats = await getEntityStats();
      } catch (e) { /* non-critical */ }
    }

    // Keyword search stats
    let keywordIndexCount = 0;
    if (isKeywordSearchAvailable()) {
      try {
        keywordIndexCount = await getKeywordIndexCount();
      } catch (e) { /* non-critical */ }
    }

    res.json({
      ...stats,
      decayed_below_50pct: decayedCount,
      decay_config: {
        factor: parseFloat(process.env.DECAY_FACTOR) || 0.98,
        affected_types: DECAY_TYPES,
      },
      ...(entityStats ? { entities: entityStats } : {}),
      retrieval: {
        multi_path: process.env.MULTI_PATH_SEARCH !== 'false',
        keyword_search: isKeywordSearchAvailable(),
        keyword_index_count: keywordIndexCount,
        graph_search: isGraphSearchAvailable(),
      },
    });
  } catch (err) {
    console.error('[stats]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
