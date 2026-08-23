import { Router } from 'express';
import { getMemoryStats, scrollPoints, computeEffectiveConfidence, DECAY_TYPES } from '../services/pgvector.js';
import { isEntityStoreAvailable, getEntityStats } from '../services/stores/interface.js';
import { isKeywordSearchAvailable, getKeywordIndexCount } from '../services/keyword-search.js';
import { logError } from '../lib/log.js';

export const statsRouter = Router();

// GET /memory/stats — Memory health dashboard
statsRouter.get('/', async (req, res) => {
  try {
    const stats = await getMemoryStats();

    // Best-effort sub-stats — a failure on any of these shouldn't blow up the
    // dashboard (it's a health surface, not a transactional path), but we log
    // so the failure is observable on the server side.
    let decayedCount = 0;
    try {
      const recentFacts = await scrollPoints({ type: 'fact' }, 100);
      const points = recentFacts.points || [];
      for (const point of points) {
        const eff = computeEffectiveConfidence(point.payload);
        if (eff < 0.5) decayedCount++;
      }
    } catch (e) {
      console.warn('[stats:decayed]', e.message);
    }

    let entityStats = null;
    if (isEntityStoreAvailable()) {
      try { entityStats = await getEntityStats(); }
      catch (e) { console.warn('[stats:entities]', e.message); }
    }

    let keywordIndexCount = 0;
    if (isKeywordSearchAvailable()) {
      try { keywordIndexCount = await getKeywordIndexCount(); }
      catch (e) { console.warn('[stats:keyword-index]', e.message); }
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
      },
    });
  } catch (err) {
    logError(req, '[stats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
