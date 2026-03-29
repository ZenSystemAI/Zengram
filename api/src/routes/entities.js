import { Router } from 'express';
import {
  isEntityStoreAvailable, listEntities, findEntity, getEntityMemories, getEntityStats,
} from '../services/stores/interface.js';

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
