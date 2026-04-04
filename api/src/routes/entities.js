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
        let memoriesAffected = 0;
        if (store?.pool) {
          const result = await store.pool.query(
            'SELECT COUNT(*) as count FROM entity_memory_links WHERE entity_id = $1', [entity.id]
          );
          memoriesAffected = parseInt(result.rows[0]?.count) || 0;
        } else if (store?.db) {
          const linkCount = store.db.prepare('SELECT COUNT(*) as count FROM entity_memory_links WHERE entity_id = @id').get({ id: entity.id });
          memoriesAffected = linkCount?.count || 0;
        }

        results.push({
          name: entity.canonical_name,
          old_type: oldType,
          new_type: entry.new_type,
          memories_affected: memoriesAffected,
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

// DELETE /entities/:name — Delete an entity and its links
entitiesRouter.delete('/:name', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).json({ error: 'Entity queries require sqlite or postgres backend.' });
    }

    const entity = await findEntity(req.params.name);
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    const store = _getStoreInstance();
    if (!store?.pool && !store?.db) {
      return res.status(500).json({ error: 'No writable store available' });
    }

    // CASCADE handles entity_memory_links and entity_aliases
    if (store.pool) {
      await store.pool.query('DELETE FROM entities WHERE id = $1', [entity.id]);
    } else if (store.db) {
      store.db.prepare('DELETE FROM entities WHERE id = @id').run({ id: entity.id });
    }

    console.log(`[entities:delete] Entity "${entity.canonical_name}" (${entity.entity_type}) deleted`);

    res.json({
      deleted: true,
      name: entity.canonical_name,
      type: entity.entity_type,
      id: entity.id,
    });
  } catch (err) {
    console.error('[entities:delete]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /entities/:name/merge — Merge another entity into this one
entitiesRouter.post('/:name/merge', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).json({ error: 'Entity queries require sqlite or postgres backend.' });
    }

    const { merge_from } = req.body;
    if (!merge_from) {
      return res.status(400).json({ error: 'merge_from is required (entity name to merge into this one)' });
    }

    const primary = await findEntity(req.params.name);
    if (!primary) {
      return res.status(404).json({ error: `Primary entity "${req.params.name}" not found` });
    }

    const secondary = await findEntity(merge_from);
    if (!secondary) {
      return res.status(404).json({ error: `Source entity "${merge_from}" not found` });
    }

    const store = _getStoreInstance();
    if (!store?.pool) {
      return res.status(500).json({ error: 'Merge requires postgres backend' });
    }

    // Move memory links from secondary to primary (skip conflicts)
    const moveResult = await store.pool.query(`
      UPDATE entity_memory_links SET entity_id = $1
      WHERE entity_id = $2
      AND NOT EXISTS (
        SELECT 1 FROM entity_memory_links existing
        WHERE existing.entity_id = $1
        AND existing.memory_id = entity_memory_links.memory_id
        AND existing.role = entity_memory_links.role
      )
    `, [primary.id, secondary.id]);
    const movedLinks = moveResult.rowCount || 0;

    // Move relationships from secondary to primary
    await store.pool.query(`
      UPDATE entity_relationships SET source_entity_id = $1
      WHERE source_entity_id = $2
      AND target_entity_id != $1
    `, [primary.id, secondary.id]).catch(() => {});
    await store.pool.query(`
      UPDATE entity_relationships SET target_entity_id = $1
      WHERE target_entity_id = $2
      AND source_entity_id != $1
    `, [primary.id, secondary.id]).catch(() => {});

    // Create alias from secondary name
    await store.pool.query(
      `INSERT INTO entity_aliases (entity_id, alias, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
      [primary.id, secondary.canonical_name]
    );

    // Update mention count on primary
    await store.pool.query(
      'UPDATE entities SET mention_count = mention_count + $1 WHERE id = $2',
      [secondary.mention_count || 0, primary.id]
    );

    // Delete secondary (CASCADE removes remaining links/aliases)
    await store.pool.query('DELETE FROM entities WHERE id = $1', [secondary.id]);

    console.log(`[entities:merge] Merged "${secondary.canonical_name}" → "${primary.canonical_name}" (${movedLinks} links moved)`);

    res.json({
      merged: true,
      primary: primary.canonical_name,
      absorbed: secondary.canonical_name,
      links_moved: movedLinks,
      alias_created: secondary.canonical_name,
    });
  } catch (err) {
    console.error('[entities:merge]', err.message);
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
