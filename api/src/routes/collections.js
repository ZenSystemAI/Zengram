import { Router } from 'express';
import { createCollection, deleteCollection, listStoredCollections, getCollectionInfo } from '../services/pgvector.js';
import {
  resolveCollection, validateCollectionSlug, registerCollection,
  unregisterCollection, listCollections, getDefaultCollection,
} from '../services/collection-registry.js';
import { requestHasOperatorApproval } from '../services/request-utils.js';
import { logError } from '../lib/log.js';

export const collectionsRouter = Router();

// GET /collections — list both the in-memory registry and any collection
// values actually present in the vector store, and mark which side each
// entry came from.
collectionsRouter.get('/', async (req, res) => {
  try {
    const [registry, stored] = await Promise.all([
      Promise.resolve(listCollections()),
      listStoredCollections(),
    ]);
    const storedNames = new Set(stored.map(c => c.name));

    const merged = registry.map(c => ({
      ...c,
      exists_in_store: storedNames.has(c.name),
    }));

    for (const sc of stored) {
      if (!registry.some(r => r.name === sc.name)) {
        merged.push({ name: sc.name, is_default: false, exists_in_store: true, discovered: true });
      }
    }

    res.json({ collections: merged });
  } catch (err) {
    logError(req, '[collections:list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /collections — create a new collection
collectionsRouter.post('/', async (req, res) => {
  try {
    const { name, description } = req.body;

    const error = validateCollectionSlug(name);
    if (error) return res.status(400).json({ error });

    const collectionName = resolveCollection(name);

    const existing = await getCollectionInfo(collectionName);
    if (existing.points_count > 0) {
      return res.status(409).json({ error: `Collection '${collectionName}' already exists` });
    }

    const result = await createCollection(collectionName);
    registerCollection(collectionName, { description: description || '' });

    console.log(`[collections] Created: ${collectionName} (${result.dimensions} dims)`);

    res.status(201).json({
      name: collectionName,
      dimensions: result.dimensions,
      description: description || '',
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    logError(req, '[collections:create]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /collections/:name
collectionsRouter.get('/:name', async (req, res) => {
  try {
    const collectionName = resolveCollection(req.params.name);
    const info = await getCollectionInfo(collectionName);
    if (info.points_count === 0) {
      return res.status(404).json({ error: 'Collection not found' });
    }
    res.json({ name: collectionName, ...info });
  } catch (err) {
    logError(req, '[collections:get]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /collections/:name
collectionsRouter.delete('/:name', async (req, res) => {
  try {
    // Hard-deletes every row in the collection — gate it behind operator approval,
    // same pattern as the destructive /export/import restore, so an agent can't
    // wipe a collection unprompted.
    if (!requestHasOperatorApproval(req)) {
      return res.status(403).json({
        error: 'operator_approved=true is required to delete a collection',
      });
    }

    const collectionName = resolveCollection(req.params.name);

    if (collectionName === getDefaultCollection()) {
      return res.status(400).json({ error: 'Cannot delete the default collection' });
    }

    await deleteCollection(collectionName);
    unregisterCollection(collectionName);

    console.log(`[collections] Deleted: ${collectionName}`);

    res.json({ deleted: true, name: collectionName });
  } catch (err) {
    logError(req, '[collections:delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
