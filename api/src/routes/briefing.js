import { Router } from 'express';
import { scrollPoints, getCollectionInfo, computeEffectiveConfidence } from '../services/qdrant.js';

export const briefingRouter = Router();

const COMPACT_MAX_CONTENT = 200;
const IMPORTANCE_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

// GET /briefing — Session briefing: what happened since timestamp
// format=compact (default): truncated content, skip low-importance events — lean for agents
// format=summary: counts + headlines only — minimal tokens
// format=full: complete content — original behavior
briefingRouter.get('/', async (req, res) => {
  try {
    const { agent, since, include, limit: limitParam, format: formatParam } = req.query;
    const format = ['compact', 'summary', 'full'].includes(formatParam) ? formatParam : 'compact';

    if (!since) {
      return res.status(400).json({
        error: 'Missing required parameter: since (ISO 8601 timestamp)',
        example: '/briefing?since=2026-03-09T00:00:00Z&agent=claude-code&format=compact',
      });
    }

    // Get recent events from Qdrant
    const scrollLimit = Math.min(Math.max(parseInt(limitParam) || 100, 1), 500);
    const filter = { created_after: since };
    const recent = await scrollPoints(filter, scrollLimit);
    const points = recent.points || [];

    // Filter points: exclude requesting agent's own entries (unless include=all)
    const filteredPoints = points.filter(point => {
      const p = point.payload;
      if (agent && p.source_agent === agent && include !== 'all') return false;
      return true;
    });

    // In compact mode, skip low-importance events (keep facts/statuses/decisions regardless)
    const relevantPoints = format === 'compact'
      ? filteredPoints.filter(p => p.payload.type !== 'event' || p.payload.importance !== 'low')
      : filteredPoints;

    // Collect entity counts (before any truncation)
    const entityCounts = {};
    for (const point of relevantPoints) {
      for (const ent of (point.payload.entities || [])) {
        if (!entityCounts[ent.name]) entityCounts[ent.name] = { name: ent.name, type: ent.type, count: 0 };
        entityCounts[ent.name].count++;
      }
    }
    const entitiesMentioned = Object.values(entityCounts).sort((a, b) => b.count - a.count);

    // Build summary (always included)
    const summary = {
      total_entries: relevantPoints.length,
      total_in_period: points.length,
      events: 0, facts_updated: 0, status_changes: 0, decisions: 0,
      agents_active: [...new Set(points.flatMap(p => p.payload.observed_by || [p.payload.source_agent]))],
      clients_mentioned: [...new Set(points.map(p => p.payload.client_id).filter(c => c !== 'global'))],
      entities_mentioned: entitiesMentioned.slice(0, 15),
    };

    // Categorize
    const buckets = { events: [], facts_updated: [], status_changes: [], decisions: [] };
    for (const point of relevantPoints) {
      const p = point.payload;
      const confidence = computeEffectiveConfidence(p);

      // Build entry based on format
      let entry;
      if (format === 'summary') {
        // Minimal: first line of content only (headline)
        const firstLine = (p.text || '').split('\n')[0].slice(0, 120);
        entry = {
          id: point.id,
          headline: firstLine,
          source_agent: p.source_agent,
          client_id: p.client_id,
          importance: p.importance,
          created_at: p.created_at,
        };
      } else if (format === 'compact') {
        // Truncated: first 200 chars + flag if truncated
        const text = p.text || '';
        const truncated = text.length > COMPACT_MAX_CONTENT;
        entry = {
          id: point.id,
          content: truncated ? text.slice(0, COMPACT_MAX_CONTENT) + '...' : text,
          truncated,
          source_agent: p.source_agent,
          client_id: p.client_id,
          importance: p.importance,
          confidence: +confidence.toFixed(3),
          created_at: p.created_at,
        };
      } else {
        // Full: original behavior
        entry = {
          id: point.id,
          content: p.text,
          source_agent: p.source_agent,
          client_id: p.client_id,
          category: p.category,
          importance: p.importance,
          confidence: +confidence.toFixed(4),
          created_at: p.created_at,
        };
      }

      switch (p.type) {
        case 'event': buckets.events.push(entry); summary.events++; break;
        case 'fact': buckets.facts_updated.push(entry); summary.facts_updated++; break;
        case 'status': buckets.status_changes.push(entry); summary.status_changes++; break;
        case 'decision': buckets.decisions.push(entry); summary.decisions++; break;
      }
    }

    // Sort by importance then recency (critical/high first, then by date)
    const sortByImportanceAndDate = (a, b) => {
      const impDiff = (IMPORTANCE_RANK[b.importance] || 0) - (IMPORTANCE_RANK[a.importance] || 0);
      if (impDiff !== 0) return impDiff;
      return new Date(b.created_at) - new Date(a.created_at);
    };
    for (const arr of Object.values(buckets)) {
      arr.sort(sortByImportanceAndDate);
    }

    // Build response based on format
    const briefing = {
      since,
      format,
      requesting_agent: agent || 'unknown',
      generated_at: new Date().toISOString(),
      summary,
    };

    if (format === 'summary') {
      // Summary: counts + top 5 headlines per bucket — minimal tokens
      const topN = 5;
      briefing.top_events = buckets.events.slice(0, topN).map(e => ({ headline: e.headline, source_agent: e.source_agent, client_id: e.client_id, created_at: e.created_at }));
      briefing.top_facts = buckets.facts_updated.slice(0, topN).map(e => ({ headline: e.headline, source_agent: e.source_agent, client_id: e.client_id }));
      briefing.top_statuses = buckets.status_changes.slice(0, topN).map(e => ({ headline: e.headline, source_agent: e.source_agent, client_id: e.client_id }));
      briefing.top_decisions = buckets.decisions.slice(0, topN).map(e => ({ headline: e.headline, source_agent: e.source_agent, client_id: e.client_id }));
    } else if (format === 'compact') {
      // Compact: truncated entries, capped at 15 per bucket
      const cap = 15;
      briefing.events = buckets.events.slice(0, cap);
      briefing.facts_updated = buckets.facts_updated.slice(0, cap);
      briefing.status_changes = buckets.status_changes.slice(0, cap);
      briefing.decisions = buckets.decisions.slice(0, cap);
    } else {
      // Full: all entries, complete content
      Object.assign(briefing, buckets);
    }

    // Collection stats (compact/full only — skip for summary to save tokens)
    if (format !== 'summary') {
      try {
        const info = await getCollectionInfo();
        briefing.brain_stats = {
          total_memories: info.points_count,
          vectors_count: info.vectors_count,
        };
      } catch (e) { /* non-critical */ }
    }

    res.json(briefing);
  } catch (err) {
    console.error('[briefing]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
