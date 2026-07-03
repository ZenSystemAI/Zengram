import { Router } from 'express';
import {
  isEntityStoreAvailable, listEntities, findEntity, getEntityMemories, getEntityStats,
  _getStoreInstance,
} from '../services/stores/interface.js';
import { reclassifyEntity } from '../services/entities.js';
import { batchUpdateEntityType } from '../services/pgvector.js';
import { logError } from '../lib/log.js';

export const entitiesRouter = Router();

// Returns true if the entity store is live. Otherwise sends a 400 and returns
// false so the caller can short-circuit with `if (!requireEntityStore(res)) return;`.
function requireEntityStore(res) {
  if (isEntityStoreAvailable()) return true;
  res.status(400).json({ error: 'Entity queries require a structured store. Set STRUCTURED_STORE=postgres in .env.' });
  return false;
}

// GET /entities — List all entities
entitiesRouter.get('/', async (req, res) => {
  try {
    if (!requireEntityStore(res)) return;

    const { type: entityType, limit, offset } = req.query;
    const result = await listEntities({ entity_type: entityType, limit, offset });

    res.json({
      count: result.results.length,
      entities: result.results,
    });
  } catch (err) {
    logError(req, '[entities]', err.message);
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
    logError(req, '[entities:stats]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /entities/reclassify — Reclassify entity types
entitiesRouter.post('/reclassify', async (req, res) => {
  try {
    if (!requireEntityStore(res)) return;

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

        // 2. Rewrite entity_type on all memory payloads in the vector store
        let vectorResult = { total_updated: 0, total_scanned: 0 };
        try {
          vectorResult = await batchUpdateEntityType(entity.canonical_name, oldType, entry.new_type);
        } catch (err) {
          console.error(`[entities:reclassify] Vector payload update failed for "${entry.name}":`, err.message);
        }

        results.push({
          name: entity.canonical_name,
          old_type: oldType,
          new_type: entry.new_type,
          memories_affected: storeResult.memories_affected,
          vector_updated: vectorResult.total_updated,
          vector_scanned: vectorResult.total_scanned,
        });

        // 3. Log the reclassification locally. (Previously this wrote an in-brain
        // audit event via a self-HTTP POST to /memory that forwarded the inbound
        // API key — removed: it coupled an internal write to the caller's auth and
        // added a pointless network hop. The event was redundant and not read anywhere.)
        console.log(`[entities:reclassify] "${entity.canonical_name}" changed from ${oldType} to ${entry.new_type}. ${storeResult.memories_affected} memories linked, ${vectorResult.total_updated} vector payloads updated.`);
      }
    }

    res.json({
      preview: isDryRun ? results : undefined,
      applied: isDryRun ? false : results,
      dry_run: isDryRun,
    });
  } catch (err) {
    logError(req, '[entities:reclassify]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /entities/:name — Single entity by name or alias
entitiesRouter.get('/:name', async (req, res) => {
  try {
    if (!requireEntityStore(res)) return;

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
    logError(req, '[entities:get]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /entities/:name — Delete an entity and its links
entitiesRouter.delete('/:name', async (req, res) => {
  try {
    if (!requireEntityStore(res)) return;

    const entity = await findEntity(req.params.name);
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    const store = _getStoreInstance();
    if (!store?.pool) {
      return res.status(500).json({ error: 'No writable store available' });
    }

    // CASCADE handles entity_memory_links and entity_aliases
    await store.pool.query('DELETE FROM entities WHERE id = $1', [entity.id]);

    console.log(`[entities:delete] Entity "${entity.canonical_name}" (${entity.entity_type}) deleted`);

    res.json({
      deleted: true,
      name: entity.canonical_name,
      type: entity.entity_type,
      id: entity.id,
    });
  } catch (err) {
    logError(req, '[entities:delete]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /entities/:name/merge — Merge another entity into this one
entitiesRouter.post('/:name/merge', async (req, res) => {
  try {
    if (!requireEntityStore(res)) return;

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

    // All five mutations run on one client in a transaction so a mid-merge
    // failure can't leave the graph half-moved (links moved but secondary still
    // alive, etc.).
    const client = await store.pool.connect();
    let movedLinks = 0;
    try {
      await client.query('BEGIN');

      // Move memory links from secondary to primary (skip conflicts)
      const moveResult = await client.query(`
        UPDATE entity_memory_links SET entity_id = $1
        WHERE entity_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM entity_memory_links existing
          WHERE existing.entity_id = $1
          AND existing.memory_id = entity_memory_links.memory_id
          AND existing.role = entity_memory_links.role
        )
      `, [primary.id, secondary.id]);
      movedLinks = moveResult.rowCount || 0;

      // Move relationships from secondary to primary. Rows that would collide
      // with an existing (source, target, type) on the primary side are skipped
      // via NOT EXISTS — a bare multi-row UPDATE would fail WHOLESALE on the
      // first 23505, and the rolled-back rows would then be destroyed by the
      // secondary's CASCADE delete below. Skipped duplicates die with the
      // secondary, which is the intended dedup.
      await client.query(`
        UPDATE entity_relationships SET source_entity_id = $1
        WHERE source_entity_id = $2 AND target_entity_id != $1
        AND NOT EXISTS (
          SELECT 1 FROM entity_relationships existing
          WHERE existing.source_entity_id = $1
          AND existing.target_entity_id = entity_relationships.target_entity_id
          AND existing.relationship_type = entity_relationships.relationship_type
        )
      `, [primary.id, secondary.id]);
      await client.query(`
        UPDATE entity_relationships SET target_entity_id = $1
        WHERE target_entity_id = $2 AND source_entity_id != $1
        AND NOT EXISTS (
          SELECT 1 FROM entity_relationships existing
          WHERE existing.target_entity_id = $1
          AND existing.source_entity_id = entity_relationships.source_entity_id
          AND existing.relationship_type = entity_relationships.relationship_type
        )
      `, [primary.id, secondary.id]);

      // Create alias from secondary name
      await client.query(
        `INSERT INTO entity_aliases (entity_id, alias, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
        [primary.id, secondary.canonical_name]
      );

      // Update mention count on primary
      await client.query(
        'UPDATE entities SET mention_count = mention_count + $1 WHERE id = $2',
        [secondary.mention_count || 0, primary.id]
      );

      // Delete secondary (CASCADE removes remaining links/aliases)
      await client.query('DELETE FROM entities WHERE id = $1', [secondary.id]);

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    console.log(`[entities:merge] Merged "${secondary.canonical_name}" → "${primary.canonical_name}" (${movedLinks} links moved)`);

    res.json({
      merged: true,
      primary: primary.canonical_name,
      absorbed: secondary.canonical_name,
      links_moved: movedLinks,
      alias_created: secondary.canonical_name,
    });
  } catch (err) {
    logError(req, '[entities:merge]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /entities/:name/memories — All memories linked to an entity
entitiesRouter.get('/:name/memories', async (req, res) => {
  try {
    if (!requireEntityStore(res)) return;

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
    logError(req, '[entities:memories]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
