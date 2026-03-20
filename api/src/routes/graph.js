import { Router } from 'express';
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
  } catch (err) {
    console.error('[graph] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
