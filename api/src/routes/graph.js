import { Router } from 'express';
<<<<<<< HEAD
import { findEntity, getRelationships } from '../services/stores/interface.js';
import { isEntityStoreAvailable } from '../services/stores/interface.js';

export const graphRouter = Router();

/**
 * GET /graph/:entity — Query entity relationships
 * Query params:
 *   - min_strength (default 1): minimum relationship strength
 *   - depth (default 1, max 3): how many hops to traverse
 */
graphRouter.get('/:entity', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(501).json({
        error: 'Entity graph requires sqlite or postgres backend. Set STRUCTURED_STORE in .env.',
      });
    }

    const entityName = req.params.entity;
    const minStrength = parseInt(req.query.min_strength) || 1;
    const depth = Math.min(Math.max(parseInt(req.query.depth) || 1, 1), 3);

    const entity = await findEntity(entityName);
    if (!entity) {
      return res.status(404).json({ error: `Entity not found: ${entityName}` });
    }

    const rootEntity = {
      id: entity.id,
      name: entity.canonical_name,
      type: entity.entity_type,
    };

    const relationships = await getRelationships(entity.id, minStrength);

    if (depth === 1) {
      return res.json({
        entity: rootEntity,
        relationships,
        depth,
      });
    }

    // For depth > 1, recursively fetch relationships of connected entities
    const visited = new Set([entity.id]);
    const enriched = await enrichRelationships(relationships, minStrength, depth - 1, visited);

    return res.json({
      entity: rootEntity,
      relationships: enriched,
      depth,
    });
=======
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  isEntityStoreAvailable, findEntity, getEntityMemories, _getStoreInstance,
} from '../services/stores/interface.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const graphTemplate = readFileSync(join(__dirname, '../templates/graph.html'), 'utf-8');

export const graphRouter = Router();

// --- Routes ---

// GET /graph/:entity/html — Interactive D3.js visualization
graphRouter.get('/:entity/html', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).send(
        '<h1>Entity store not available</h1><p>Graph visualization requires sqlite or postgres backend.</p>'
      );
    }

    const entityName = decodeURIComponent(req.params.entity);
    const depth = Math.min(parseInt(req.query.depth) || 2, 4);

    // Verify entity exists
    const entity = await findEntity(entityName);
    if (!entity) {
      return res.status(404).send(
        `<h1>Entity not found</h1><p>"${escapeHtml(entityName)}" was not found in the knowledge graph.</p>`
      );
    }

    const displayName = entity.canonical_name;
    const graphData = await buildGraphData(displayName, depth);

    // Render template
    const html = graphTemplate
      .replace(/\{\{ENTITY_NAME\}\}/g, escapeHtml(displayName))
      .replace('{{GRAPH_DATA}}', JSON.stringify(graphData));

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[graph:html] Error:', err.message);
    res.status(500).send(`<h1>Error</h1><p>${escapeHtml(err.message)}</p>`);
  }
});

// GET /graph/:entity — JSON graph data
graphRouter.get('/:entity', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).json({
        error: 'Entity queries require sqlite or postgres backend.',
      });
    }

    const entityName = decodeURIComponent(req.params.entity);
    const depth = Math.min(parseInt(req.query.depth) || 2, 4);

    const entity = await findEntity(entityName);
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    const graphData = await buildGraphData(entity.canonical_name, depth);
    res.json(graphData);
>>>>>>> worktree-agent-a801b191
  } catch (err) {
    console.error('[graph] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

<<<<<<< HEAD
/**
 * Recursively fetch nested relationships up to remaining depth.
 * Uses a visited set to avoid cycles.
 */
async function enrichRelationships(relationships, minStrength, remainingDepth, visited) {
  if (remainingDepth <= 0) return relationships;

  const enriched = [];
  for (const rel of relationships) {
    const enrichedRel = { ...rel };
    if (!visited.has(rel.entity.id)) {
      visited.add(rel.entity.id);
      const nested = await getRelationships(rel.entity.id, minStrength);
      // Filter out already-visited entities from nested results
      const filtered = nested.filter(n => !visited.has(n.entity.id));
      enrichedRel.relationships = await enrichRelationships(filtered, minStrength, remainingDepth - 1, visited);
    } else {
      enrichedRel.relationships = [];
    }
    enriched.push(enrichedRel);
  }
  return enriched;
}

/**
 * GET /graph/:entity/html — Placeholder for D3.js visualization (Task 11)
 */
graphRouter.get('/:entity/html', async (req, res) => {
  if (!isEntityStoreAvailable()) {
    return res.status(501).json({
      error: 'Entity graph requires sqlite or postgres backend. Set STRUCTURED_STORE in .env.',
    });
  }

  const entityName = req.params.entity;
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Graph: ${entityName}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0; }
    .loading { text-align: center; }
    .loading h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .loading p { color: #888; }
  </style>
</head>
<body>
  <div class="loading">
    <h1>Graph visualization loading...</h1>
    <p>Entity: <strong>${entityName}</strong></p>
    <p>Full D3.js interactive visualization coming in the next update.</p>
  </div>
</body>
</html>`);
});
=======
// --- Graph building ---

/**
 * Build graph data using co-occurrence from entity_memory_links.
 * Entities that share memory_ids are considered connected.
 * BFS traversal up to `depth` levels from the center entity.
 */
async function buildGraphData(centerName, depth) {
  const visited = new Map();  // lowercase name -> node object
  const edgeMap = new Map();  // "A||B" -> edge object
  const queue = [{ name: centerName, currentDepth: 0 }];

  while (queue.length > 0) {
    const { name, currentDepth } = queue.shift();
    const lowerName = name.toLowerCase();

    if (visited.has(lowerName)) continue;

    const entity = await findEntity(name);
    if (!entity) continue;

    const node = {
      id: entity.canonical_name,
      type: entity.entity_type,
      mention_count: entity.mention_count || 1,
    };
    visited.set(entity.canonical_name.toLowerCase(), node);

    // Stop expanding at max depth
    if (currentDepth >= depth) continue;

    // Find co-occurring entities via shared memory_ids
    const coEntities = await findCoOccurringEntities(entity.id, 40);

    for (const co of coEntities) {
      // Create or update edge
      const edgeKey = [entity.canonical_name, co.canonical_name].sort().join('||');
      if (edgeMap.has(edgeKey)) {
        edgeMap.get(edgeKey).strength = Math.max(edgeMap.get(edgeKey).strength, co.shared_count);
      } else {
        edgeMap.set(edgeKey, {
          source: entity.canonical_name,
          target: co.canonical_name,
          type: 'co_occurrence',
          strength: co.shared_count,
        });
      }

      // Enqueue for BFS expansion
      if (!visited.has(co.canonical_name.toLowerCase())) {
        queue.push({ name: co.canonical_name, currentDepth: currentDepth + 1 });
      }
    }
  }

  return {
    nodes: Array.from(visited.values()),
    edges: Array.from(edgeMap.values()),
    center: centerName,
  };
}

/**
 * Find entities that co-occur with the given entity (share memory_ids).
 * Uses direct DB access for efficient batch queries.
 * Falls back to interface-level queries if direct access unavailable.
 */
async function findCoOccurringEntities(entityId, limit = 40) {
  try {
    const store = _getStoreInstance();

    // Direct DB path (SQLite) — most efficient
    if (store?.db) {
      return findCoOccurringDirect(store.db, entityId, limit);
    }

    // Fallback: use interface-level getEntityMemories
    return await findCoOccurringViaInterface(entityId, limit);
  } catch (err) {
    console.error('[graph] findCoOccurringEntities error:', err.message);
    return [];
  }
}

/**
 * Direct DB query for co-occurring entities (SQLite).
 */
function findCoOccurringDirect(db, entityId, limit) {
  // Get memory_ids for this entity
  const links = db.prepare(
    'SELECT memory_id FROM entity_memory_links WHERE entity_id = ?'
  ).all(entityId);

  if (links.length === 0) return [];

  const memoryIds = links.map(l => l.memory_id);

  // Batch to avoid SQLite variable limits
  const batchSize = 200;
  const coMap = new Map();

  for (let i = 0; i < memoryIds.length; i += batchSize) {
    const batch = memoryIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');

    const rows = db.prepare(`
      SELECT eml.entity_id, e.canonical_name, e.entity_type, e.mention_count,
             COUNT(DISTINCT eml.memory_id) as shared_count
      FROM entity_memory_links eml
      JOIN entities e ON e.id = eml.entity_id
      WHERE eml.memory_id IN (${placeholders})
        AND eml.entity_id != ?
      GROUP BY eml.entity_id
      ORDER BY shared_count DESC
      LIMIT ?
    `).all(...batch, entityId, limit);

    for (const row of rows) {
      if (coMap.has(row.entity_id)) {
        coMap.get(row.entity_id).shared_count += row.shared_count;
      } else {
        coMap.set(row.entity_id, row);
      }
    }
  }

  return Array.from(coMap.values())
    .sort((a, b) => b.shared_count - a.shared_count)
    .slice(0, limit);
}

/**
 * Fallback: find co-occurring entities via the store interface.
 * Less efficient but works with any backend.
 */
async function findCoOccurringViaInterface(entityId, limit) {
  const memLinks = await getEntityMemories(entityId, 500);
  const memoryIds = memLinks.results.map(l => l.memory_id);
  if (memoryIds.length === 0) return [];

  const store = _getStoreInstance();
  if (!store?.db) return []; // Can't proceed without direct access

  return findCoOccurringDirect(store.db, entityId, limit);
}

// --- Utilities ---

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
>>>>>>> worktree-agent-a801b191
