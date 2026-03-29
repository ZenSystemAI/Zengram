import { Router } from 'express';
import {
  isEntityStoreAvailable, listEntities, findEntity, getEntityMemories, getEntityStats,
  _getStoreInstance,
} from '../services/stores/interface.js';
import { reclassifyEntity } from '../services/entities.js';
import { batchUpdateEntityType } from '../services/qdrant.js';
import { findMisclassifiedEntities } from '../services/entity-type-heuristics.js';

export const entitiesRouter = Router();

// GET /entities — List all entities
entitiesRouter.get('/', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).json({
        error: 'Entity queries require sqlite or postgres backend. Set STRUCTURED_STORE in .env.',
      });
    }

    const { type: entityType, limit, offset } = req.query;
    const result = await listEntities({ entity_type: entityType, limit, offset });

    res.json({
      count: result.results.length,
      entities: result.results,
    });
  } catch (err) {
    console.error('[entities]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /entities/stats — Entity stats
entitiesRouter.get('/stats', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.json({ total: 0, by_type: {}, top_mentioned: [] });
    }
    const stats = await getEntityStats();
    res.json(stats);
  } catch (err) {
    console.error('[entities:stats]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /entities/reclassify/suggestions — Auto-suggest misclassified entities
entitiesRouter.get('/reclassify/suggestions', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).json({ error: 'Entity queries require sqlite or postgres backend.' });
    }

    // Fetch all entities (high limit to scan them all)
    const result = await listEntities({ limit: 5000 });
    const suggestions = findMisclassifiedEntities(result.results);

    res.json({
      count: suggestions.length,
      suggestions,
    });
  } catch (err) {
    console.error('[entities:reclassify:suggestions]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /entities/reclassify — Reclassify entity types
entitiesRouter.post('/reclassify', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).json({ error: 'Entity queries require sqlite or postgres backend.' });
    }

    const { reclassifications, dry_run } = req.body;
    const isDryRun = dry_run !== false; // default true

    if (!Array.isArray(reclassifications) || reclassifications.length === 0) {
      return res.status(400).json({ error: 'reclassifications array is required and must not be empty' });
    }

    const VALID_TYPES = ['client', 'person', 'system', 'service', 'domain', 'technology', 'workflow', 'agent'];

    // Validate all entries
    for (const entry of reclassifications) {
      if (!entry.name || typeof entry.name !== 'string') {
        return res.status(400).json({ error: `Each reclassification must have a "name" string` });
      }
      if (!entry.new_type || !VALID_TYPES.includes(entry.new_type)) {
        return res.status(400).json({ error: `Invalid new_type "${entry.new_type}" for "${entry.name}". Valid types: ${VALID_TYPES.join(', ')}` });
      }
    }

    const results = [];

    for (const entry of reclassifications) {
      const entity = await findEntity(entry.name);
      if (!entity) {
        results.push({
          name: entry.name,
          old_type: entry.current_type || 'unknown',
          new_type: entry.new_type,
          memories_affected: 0,
          error: 'Entity not found',
        });
        continue;
      }

      const oldType = entity.entity_type;

      if (isDryRun) {
        // Count linked memories for preview
        const store = _getStoreInstance();
        const linkCount = store?.db
          ? store.db.prepare('SELECT COUNT(*) as count FROM entity_memory_links WHERE entity_id = @id').get({ id: entity.id })
          : { count: 0 };

        results.push({
          name: entity.canonical_name,
          old_type: oldType,
          new_type: entry.new_type,
          memories_affected: linkCount?.count || 0,
        });
      } else {
        // 1. Update structured store
        const storeResult = await reclassifyEntity(entry.name, entry.new_type, {
          findEntity,
          _getStoreInstance,
        });

        // 2. Update Qdrant payloads in chunks
        let qdrantResult = { total_updated: 0, total_scanned: 0 };
        try {
          qdrantResult = await batchUpdateEntityType(entity.canonical_name, oldType, entry.new_type);
        } catch (err) {
          console.error(`[entities:reclassify] Qdrant update failed for "${entry.name}":`, err.message);
        }

        results.push({
          name: entity.canonical_name,
          old_type: oldType,
          new_type: entry.new_type,
          memories_affected: storeResult.memories_affected,
          qdrant_updated: qdrantResult.total_updated,
          qdrant_scanned: qdrantResult.total_scanned,
        });

        // 3. Log reclassification as an event in the brain (fire-and-forget)
        try {
          const internalUrl = `http://localhost:${process.env.PORT || 8084}/memory`;
          const apiKey = req.headers['x-api-key'];
          fetch(internalUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(apiKey ? { 'x-api-key': apiKey } : {}),
            },
            body: JSON.stringify({
              type: 'event',
              content: `Entity reclassified: "${entity.canonical_name}" changed from ${oldType} to ${entry.new_type}. ${storeResult.memories_affected} memories linked, ${qdrantResult.total_updated} Qdrant payloads updated.`,
              source_agent: 'system',
              client_id: 'global',
              category: 'episodic',
              importance: 'medium',
            }),
          }).catch(e => console.error('[entities:reclassify:log]', e.message));
        } catch (e) {
          console.error('[entities:reclassify:log]', e.message);
        }
      }
    }

    res.json({
      preview: isDryRun ? results : undefined,
      applied: isDryRun ? false : results,
      dry_run: isDryRun,
    });
  } catch (err) {
    console.error('[entities:reclassify]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /entities/:name — Single entity by name or alias
entitiesRouter.get('/:name', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).json({ error: 'Entity queries require sqlite or postgres backend.' });
    }

    const entity = await findEntity(req.params.name);
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    res.json({
      id: entity.id,
      canonical_name: entity.canonical_name,
      entity_type: entity.entity_type,
      first_seen: entity.first_seen,
      last_seen: entity.last_seen,
      mention_count: entity.mention_count,
      aliases: entity.aliases || [],
    });
  } catch (err) {
    console.error('[entities:get]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /entities/:name/memories — All memories linked to an entity
entitiesRouter.get('/:name/memories', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).json({ error: 'Entity queries require sqlite or postgres backend.' });
    }

    const entity = await findEntity(req.params.name);
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    const limit = parseInt(req.query.limit) || 20;
    const links = await getEntityMemories(entity.id, limit);

    res.json({
      entity: entity.canonical_name,
      entity_type: entity.entity_type,
      count: links.results.length,
      memory_links: links.results,
    });
  } catch (err) {
    console.error('[entities:memories]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
