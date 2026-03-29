import { Router } from 'express';
import { createQdrantCollection, deleteQdrantCollection, listQdrantCollections, getCollectionInfo } from '../services/qdrant.js';
import {
  resolveCollection, validateCollectionSlug, registerCollection,
  unregisterCollection, listCollections, getDefaultCollection,
} from '../services/collection-registry.js';

export const collectionsRouter = Router();

// GET /collections — List all known collections
collectionsRouter.get('/', async (req, res) => {
  try {
    // Get registry + actual Qdrant collections
    const [registry, qdrantCollections] = await Promise.all([
      Promise.resolve(listCollections()),
      listQdrantCollections(),
    ]);

    const qdrantNames = new Set(qdrantCollections.map(c => c.name));

    // Merge: mark registry entries with Qdrant existence
    const merged = registry.map(c => ({
      ...c,
      exists_in_qdrant: qdrantNames.has(c.name),
    }));

    // Add Qdrant collections not in registry (discovered)
    for (const qc of qdrantCollections) {
      if (!registry.some(r => r.name === qc.name)) {
        merged.push({ name: qc.name, is_default: false, exists_in_qdrant: true, discovered: true });
      }
    }

    res.json({ collections: merged });
  } catch (err) {
    console.error('[collections:list]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /collections — Create a new collection
collectionsRouter.post('/', async (req, res) => {
  try {
    const { name, description } = req.body;

    const error = validateCollectionSlug(name);
    if (error) return res.status(400).json({ error });

    const collectionName = resolveCollection(name);

    // Check if already exists in Qdrant
    try {
      await getCollectionInfo(name);
      return res.status(409).json({ error: `Collection '${collectionName}' already exists` });
    } catch (e) {
      if (!e.message?.includes('404')) throw e;
      // 404 = doesn't exist, good to create
    }

    const result = await createQdrantCollection(collectionName);
    registerCollection(collectionName, { description: description || '' });

    console.log(`[collections] Created: ${collectionName} (${result.dimensions} dims)`);

    res.status(201).json({
      name: collectionName,
      dimensions: result.dimensions,
      description: description || '',
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[collections:create]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /collections/:name — Get collection info
collectionsRouter.get('/:name', async (req, res) => {
  try {
    const collectionName = resolveCollection(req.params.name);
    const info = await getCollectionInfo(req.params.name);
    res.json({ name: collectionName, ...info });
  } catch (err) {
    if (err.message?.includes('404')) {
      return res.status(404).json({ error: 'Collection not found' });
    }
    console.error('[collections:get]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /collections/:name — Delete a collection (admin only, not the default)
collectionsRouter.delete('/:name', async (req, res) => {
  try {
    const collectionName = resolveCollection(req.params.name);

    if (collectionName === getDefaultCollection()) {
      return res.status(400).json({ error: 'Cannot delete the default collection' });
    }

    // Agent-scoped keys cannot delete collections
    if (req.authenticatedAgent) {
      return res.status(403).json({ error: 'Only admin keys can delete collections' });
    }

    await deleteQdrantCollection(collectionName);
    unregisterCollection(collectionName);

    console.log(`[collections] Deleted: ${collectionName}`);

    res.json({ deleted: true, name: collectionName });
  } catch (err) {
    if (err.message?.includes('404')) {
      return res.status(404).json({ error: 'Collection not found' });
    }
    console.error('[collections:delete]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
