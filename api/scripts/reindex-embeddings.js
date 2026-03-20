#!/usr/bin/env node
/**
 * Re-embed all memories with the current embedding provider.
 * Use this when switching embedding providers or changing dimensions.
 *
 * What it does:
 * 1. Scrolls all points from the current Qdrant collection
 * 2. Saves all payloads + IDs
 * 3. Deletes the old collection
 * 4. Recreates it with the new embedding dimensions
 * 5. Re-embeds each memory and upserts the new vector + original payload
 *
 * Usage:
 *   node api/scripts/reindex-embeddings.js
 *   node api/scripts/reindex-embeddings.js --dry-run   # preview without changes
 *
 * Requires: .env configured with QDRANT_URL, EMBEDDING_PROVIDER, and provider credentials
 */

try { await import('dotenv/config'); } catch (e) { /* dotenv not needed in Docker */ }
import { initEmbeddings, embed, getEmbeddingDimensions } from '../src/services/embedders/interface.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = 'shared_memories';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 10;
const DELAY_MS = 200; // rate-limit protection

async function qdrantRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (QDRANT_API_KEY) headers['api-key'] = QDRANT_API_KEY;
  const res = await fetch(`${QDRANT_URL}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Qdrant ${options.method || 'GET'} ${path}: ${res.status} ${body}`);
  }
  return res.json();
}

async function scrollAll() {
  const points = [];
  let offset = null;
  while (true) {
    const body = { limit: 100, with_payload: true, with_vector: false };
    if (offset) body.offset = offset;
    const result = await qdrantRequest(`/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const batch = result.result?.points || [];
    points.push(...batch);
    offset = result.result?.next_page_offset;
    if (!offset || batch.length === 0) break;
  }
  return points;
}

async function deleteCollection() {
  await qdrantRequest(`/collections/${COLLECTION}`, { method: 'DELETE' });
}

async function createCollection(dims) {
  await qdrantRequest(`/collections/${COLLECTION}`, {
    method: 'PUT',
    body: JSON.stringify({
      vectors: { size: dims, distance: 'Cosine' },
      optimizers_config: { indexing_threshold: 100 },
    }),
  });

  // Recreate all payload indices (best-effort — some may fail on older Qdrant versions)
  const indexes = [
    ...['type', 'source_agent', 'client_id', 'category', 'importance', 'content_hash', 'key', 'subject']
      .map(f => ({ field_name: f, field_schema: 'Keyword' })),
    { field_name: 'active', field_schema: 'Bool' },
    { field_name: 'confidence', field_schema: 'Float' },
    { field_name: 'access_count', field_schema: 'Integer' },
    { field_name: 'created_at', field_schema: 'Datetime' },
    { field_name: 'last_accessed_at', field_schema: 'Datetime' },
    { field_name: 'entities[].name', field_schema: 'keyword' },
  ];
  for (const idx of indexes) {
    try {
      await qdrantRequest(`/collections/${COLLECTION}/index`, {
        method: 'PUT',
        body: JSON.stringify(idx),
      });
    } catch (e) {
      console.warn(`[reindex] Index ${idx.field_name} failed (non-blocking): ${e.message}`);
    }
  }
}

async function upsertBatch(points) {
  await qdrantRequest(`/collections/${COLLECTION}/points`, {
    method: 'PUT',
    body: JSON.stringify({ points }),
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('[reindex] Initializing embedding provider...');
  await initEmbeddings();
  const newDims = getEmbeddingDimensions();
  console.log(`[reindex] Target: ${process.env.EMBEDDING_PROVIDER}, ${newDims} dimensions`);

  // Step 1: Scroll all existing points
  console.log('[reindex] Scrolling all points from Qdrant...');
  const allPoints = await scrollAll();
  console.log(`[reindex] Found ${allPoints.length} memories to re-embed`);

  if (allPoints.length === 0) {
    console.log('[reindex] No points found. Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    console.log('[reindex] DRY RUN — would delete collection, recreate at', newDims, 'dims, and re-embed', allPoints.length, 'memories');
    console.log('[reindex] Sample IDs:', allPoints.slice(0, 5).map(p => p.id));
    return;
  }

  // Step 2: Delete old collection
  console.log('[reindex] Deleting old collection...');
  await deleteCollection();

  // Step 3: Create new collection with new dimensions
  console.log(`[reindex] Creating collection with ${newDims} dimensions...`);
  await createCollection(newDims);

  // Step 4: Re-embed and upsert in batches
  let done = 0;
  let errors = 0;
  for (let i = 0; i < allPoints.length; i += BATCH_SIZE) {
    const batch = allPoints.slice(i, i + BATCH_SIZE);
    const newPoints = [];

    for (const point of batch) {
      try {
        // Use the content field for embedding, fall back to type+key
        const text = point.payload.content
          || `${point.payload.type}: ${point.payload.key || point.payload.subject || 'unknown'}`;
        const vector = await embed(text, 'store');
        newPoints.push({ id: point.id, vector, payload: point.payload });
      } catch (err) {
        errors++;
        console.error(`[reindex] Failed to embed point ${point.id}: ${err.message}`);
      }
    }

    if (newPoints.length > 0) {
      await upsertBatch(newPoints);
      done += newPoints.length;
    }

    process.stdout.write(`\r[reindex] Progress: ${done}/${allPoints.length} (${errors} errors)`);
    if (i + BATCH_SIZE < allPoints.length) await sleep(DELAY_MS);
  }

  console.log(`\n[reindex] Complete. ${done} memories re-embedded, ${errors} errors.`);
}

main().catch(err => {
  console.error('[reindex] Fatal:', err);
  process.exit(1);
});
