import { Router } from 'express';
import { scrollPoints, getCollectionInfo, computeEffectiveConfidence } from '../services/qdrant.js';
// Briefing primarily uses Qdrant — structured store imports kept for potential future use

export const briefingRouter = Router();

// GET /briefing — Session briefing: what happened since timestamp
briefingRouter.get('/', async (req, res) => {
  try {
    const { agent, since, include } = req.query;

    if (!since) {
      return res.status(400).json({
        error: 'Missing required parameter: since (ISO 8601 timestamp)',
        example: '/briefing?since=2026-03-09T00:00:00Z&agent=claude-code',
      });
    }

    const briefing = {
      since,
      requesting_agent: agent || 'unknown',
      generated_at: new Date().toISOString(),
      events: [],
      facts_updated: [],
      status_changes: [],
      decisions: [],
      summary: {},
    };

    // Get recent events from Qdrant (semantic store has everything)
    const filter = { created_after: since };
    const recent = await scrollPoints(filter, 100);
    const points = recent.points || [];

    // Categorize results
    for (const point of points) {
      const p = point.payload;
      // Skip entries from the requesting agent (they already know what they did)
      // Unless include=all is set
      if (agent && p.source_agent === agent && include !== 'all') continue;

      const entry = {
        id: point.id,
        content: p.text,
        source_agent: p.source_agent,
        client_id: p.client_id,
        category: p.category,
        importance: p.importance,
        confidence: computeEffectiveConfidence(p),
        created_at: p.created_at,
      };

      switch (p.type) {
        case 'event': briefing.events.push(entry); break;
        case 'fact': briefing.facts_updated.push(entry); break;
        case 'status': briefing.status_changes.push(entry); break;
        case 'decision': briefing.decisions.push(entry); break;
      }
    }

    // Sort each by created_at descending
    const sortDesc = (a, b) => new Date(b.created_at) - new Date(a.created_at);
    briefing.events.sort(sortDesc);
    briefing.facts_updated.sort(sortDesc);
    briefing.status_changes.sort(sortDesc);
    briefing.decisions.sort(sortDesc);

    // Collect entities mentioned across all briefing entries
    const entityCounts = {};
    for (const point of points) {
      const entities = point.payload.entities || [];
      for (const ent of entities) {
        const key = ent.name;
        if (!entityCounts[key]) entityCounts[key] = { name: ent.name, type: ent.type, count: 0 };
        entityCounts[key].count++;
      }
    }
    const entitiesMentioned = Object.values(entityCounts).sort((a, b) => b.count - a.count);

    // Summary stats
    briefing.summary = {
      total_entries: points.length,
      events: briefing.events.length,
      facts_updated: briefing.facts_updated.length,
      status_changes: briefing.status_changes.length,
      decisions: briefing.decisions.length,
      agents_active: [...new Set(points.flatMap(p => p.payload.observed_by || [p.payload.source_agent]))],
      clients_mentioned: [...new Set(points.map(p => p.payload.client_id).filter(c => c !== 'global'))],
      entities_mentioned: entitiesMentioned.slice(0, 20),
    };

    // Get collection stats
    try {
      const info = await getCollectionInfo();
      briefing.brain_stats = {
        total_memories: info.points_count,
        vectors_count: info.vectors_count,
      };
    } catch (e) {
      // Non-critical
    }

    res.json(briefing);
  } catch (err) {
    console.error('[briefing] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
