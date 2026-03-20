import { Router } from 'express';
import { scrollPoints, searchPoints } from '../services/qdrant.js';
import { embed } from '../services/embedders/interface.js';
import { getClientResolver } from '../services/client-resolver.js';

export const clientRouter = Router();

const KNOWLEDGE_CATEGORIES = ['brand', 'strategy', 'meeting', 'content', 'technical', 'relationship'];
const COMPACT_MAX = 200;
const BRIEFING_PER_CATEGORY = 3;
const SCROLL_LIMIT = 20;

// GET /client/fingerprints — raw fingerprint data for external consumers (Fireflies, n8n)
// IMPORTANT: registered BEFORE /:clientId to avoid route collision
clientRouter.get('/fingerprints', (req, res) => {
  try {
    const resolver = getClientResolver();
    const fingerprints = resolver.clients.map(c => ({
      client_id: c.client_id,
      patterns: {
        aliases: c.aliases,
        people: c.people,
        domains: c.domains,
        keywords: c.keywords,
      },
    }));

    res.json({ fingerprints });
  } catch (err) {
    console.error('[client:fingerprints] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /client/:clientId — client briefing or filtered search
clientRouter.get('/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { query, category, format } = req.query;
    const isCompact = format === 'compact';

    // Resolve fuzzy name via client resolver
    const resolver = getClientResolver();
    const resolved = resolver.resolve(clientId);
    const effectiveClientId = typeof resolved === 'string' ? resolved : clientId;

    if (query) {
      // --- Search mode ---
      const vector = await embed(query);

      const filter = {
        client_id: effectiveClientId,
        active: true,
      };
      if (category) filter.knowledge_category = category;

      const rawResults = await searchPoints(vector, filter, 10);

      const results = rawResults.map(r => {
        const p = r.payload;
        if (isCompact) {
          const text = p.text || '';
          return {
            id: r.id,
            score: +r.score.toFixed(4),
            type: p.type,
            content: text.length > COMPACT_MAX ? text.slice(0, COMPACT_MAX) + '...' : text,
            knowledge_category: p.knowledge_category || null,
            source_agent: p.source_agent,
            created_at: p.created_at,
          };
        }

        return {
          id: r.id,
          score: r.score,
          ...p,
        };
      });

      return res.json({
        client_id: effectiveClientId,
        mode: 'search',
        query,
        count: results.length,
        results,
      });
    }

    // --- Briefing mode ---
    const knowledge = {};

    for (const cat of KNOWLEDGE_CATEGORIES) {
      const scrollFilter = {
        client_id: effectiveClientId,
        active: true,
        knowledge_category: cat,
      };

      const scrollResult = await scrollPoints(scrollFilter, SCROLL_LIMIT);
      const points = scrollResult.points || [];

      // Sort by created_at descending (Qdrant scroll doesn't sort by payload)
      points.sort((a, b) => {
        const dateA = a.payload?.created_at || '';
        const dateB = b.payload?.created_at || '';
        return dateB.localeCompare(dateA);
      });

      // Take top N
      const topPoints = points.slice(0, BRIEFING_PER_CATEGORY);

      knowledge[cat] = topPoints.map(p => {
        const payload = p.payload;
        const text = payload.text || '';
        if (isCompact) {
          return {
            id: p.id,
            type: payload.type,
            content: text.length > COMPACT_MAX ? text.slice(0, COMPACT_MAX) + '...' : text,
            source_agent: payload.source_agent,
            created_at: payload.created_at,
          };
        }

        return {
          id: p.id,
          type: payload.type,
          content: text,
          source_agent: payload.source_agent,
          importance: payload.importance,
          created_at: payload.created_at,
          metadata: payload.metadata || null,
        };
      });
    }

    res.json({
      client_id: effectiveClientId,
      mode: 'briefing',
      knowledge,
    });
  } catch (err) {
    console.error('[client:briefing] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
