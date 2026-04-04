import { getEmbeddingDimensions } from './embedders/interface.js';
import { resolveCollection, getDefaultCollection } from './collection-registry.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = 'shared_memories'; // default — kept for backward compat

// Helper: resolve collection name from optional parameter
function col(collection) { return collection ? resolveCollection(collection) : COLLECTION; }

// Memory decay config
const DECAY_FACTOR = parseFloat(process.env.DECAY_FACTOR) || 0.98;
const DECAY_TYPES = ['fact', 'status']; // events and decisions are historical — don't decay

const QDRANT_TIMEOUT_MS = parseInt(process.env.QDRANT_TIMEOUT_MS) || 10000;

const QDRANT_MAX_RETRIES = parseInt(process.env.QDRANT_MAX_RETRIES) || 1;

async function qdrantRequestOnce(path, options, timeoutMs) {
  const headers = { 'Content-Type': 'application/json' };
  if (QDRANT_API_KEY) headers['api-key'] = QDRANT_API_KEY;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${QDRANT_URL}${path}`, { ...options, headers: { ...headers, ...options.headers }, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Qdrant ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Qdrant request timed out after ${timeoutMs}ms: ${options.method || 'GET'} ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function qdrantRequest(path, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= QDRANT_MAX_RETRIES; attempt++) {
    try {
      // Double timeout on retry attempts
      const timeoutMs = QDRANT_TIMEOUT_MS * (attempt + 1);
      return await qdrantRequestOnce(path, options, timeoutMs);
    } catch (err) {
      lastErr = err;
      const isTimeout = err.message?.includes('timed out');
      const isNetworkError = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET';
      if ((isTimeout || isNetworkError) && attempt < QDRANT_MAX_RETRIES) {
        console.warn(`[qdrant] Retry ${attempt + 1}/${QDRANT_MAX_RETRIES} for ${options.method || 'GET'} ${path}: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function initQdrant() {
  // Check if collection exists
  try {
    await qdrantRequest(`/collections/${COLLECTION}`);
    console.log(`[qdrant] Collection '${COLLECTION}' exists`);
    return;
  } catch (e) {
    if (!e.message || !e.message.includes('404')) {
      throw e;
    }
  }

  const embeddingDims = getEmbeddingDimensions();
  await qdrantRequest('/collections/' + COLLECTION, {
    method: 'PUT',
    body: JSON.stringify({
      vectors: {
        size: embeddingDims,
        distance: 'Cosine',
      },
      optimizers_config: {
        indexing_threshold: 100,
      },
    }),
  });

  // Create payload indices for common filters
  const keywordFields = ['type', 'source_agent', 'client_id', 'category', 'importance', 'content_hash', 'key', 'subject', 'knowledge_category'];
  for (const field of keywordFields) {
    await qdrantRequest(`/collections/${COLLECTION}/index`, {
      method: 'PUT',
      body: JSON.stringify({ field_name: field, field_schema: 'keyword' }),
    });
  }

  // Boolean index for active/inactive filtering
  await qdrantRequest(`/collections/${COLLECTION}/index`, {
    method: 'PUT',
    body: JSON.stringify({ field_name: 'active', field_schema: 'Bool' }),
  });

  // Float index for confidence scoring
  await qdrantRequest(`/collections/${COLLECTION}/index`, {
    method: 'PUT',
    body: JSON.stringify({ field_name: 'confidence', field_schema: 'Float' }),
  });

  // Integer index for access count
  await qdrantRequest(`/collections/${COLLECTION}/index`, {
    method: 'PUT',
    body: JSON.stringify({ field_name: 'access_count', field_schema: 'Integer' }),
  });

  // Datetime indices
  for (const field of ['created_at', 'last_accessed_at']) {
    await qdrantRequest(`/collections/${COLLECTION}/index`, {
      method: 'PUT',
      body: JSON.stringify({ field_name: field, field_schema: { type: 'datetime', is_tenant: false } }),
    });
  }

  // Keyword index on entities array for entity-filtered search
  await qdrantRequest(`/collections/${COLLECTION}/index`, {
    method: 'PUT',
    body: JSON.stringify({ field_name: 'entities[].name', field_schema: 'keyword'}),
  });

  console.log(`[qdrant] Collection '${COLLECTION}' created with indices`);
}

// Ensure additional indexes exist on existing collections (idempotent)
export async function ensureEntityIndex() {
  const indexes = [
    { field_name: 'entities[].name', field_schema: 'keyword' },
    { field_name: 'key', field_schema: 'keyword' },
    { field_name: 'subject', field_schema: 'keyword' },
  ];
  for (const idx of indexes) {
    try {
      await qdrantRequest(`/collections/${COLLECTION}/index`, {
        method: 'PUT',
        body: JSON.stringify(idx),
      });
    } catch (e) {
      if (!e.message.includes('already exists')) {
        console.warn(`[qdrant] Index creation for ${idx.field_name}:`, e.message);
      }
    }
  }
  console.log('[qdrant] Payload indexes verified');
}

export async function upsertPoint(id, vector, payload, collection) {
  return qdrantRequest(`/collections/${col(collection)}/points`, {
    method: 'PUT',
    body: JSON.stringify({
      points: [{ id, vector, payload }],
    }),
  });
}

export async function searchPoints(vector, filter = {}, limit = 10, nestedFilters = [], rangeFilters = [], collection) {
  const body = {
    vector,
    limit,
    with_payload: true,
    score_threshold: 0.3,
  };

  const must = [];
  if (Object.keys(filter).length > 0) {
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== null) {
        must.push({ key, match: { value } });
      }
    }
  }

  // Support nested array payload filters (e.g., entities[].name)
  for (const nf of nestedFilters) {
    must.push({
      nested: {
        key: nf.arrayField,
        filter: { must: [{ key: nf.key, match: { value: nf.value } }] },
      },
    });
  }

  // Support range filters (e.g., valid_from <= at_time)
  for (const rf of rangeFilters) {
    must.push({ key: rf.key, range: rf.range });
  }

  if (must.length > 0) {
    body.filter = { must };
  }

  const result = await qdrantRequest(`/collections/${col(collection)}/points/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return result.result || [];
}

export async function scrollPoints(filter = {}, limit = 50, offset = null, collection) {
  const body = { limit, with_payload: true };

  if (offset) body.offset = offset;

  if (Object.keys(filter).length > 0) {
    body.filter = { must: [] };
    for (const [key, value] of Object.entries(filter)) {
      if (key === 'created_after') {
        body.filter.must.push({ key: 'created_at', range: { gte: value } });
      } else if (value !== undefined && value !== null) {
        body.filter.must.push({ key, match: { value } });
      }
    }
    if (body.filter.must.length === 0) delete body.filter;
  }

  const result = await qdrantRequest(`/collections/${col(collection)}/points/scroll`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return result.result || {};
}

export async function getCollectionInfo(collection) {
  const result = await qdrantRequest(`/collections/${col(collection)}`);
  return result.result;
}

// Fetch a single point by ID
export async function getPoint(pointId, collection) {
  const result = await qdrantRequest(`/collections/${col(collection)}/points/${pointId}`);
  return result.result || null;
}

// Batch retrieve points by IDs (for RRF fusion — fetch payloads for keyword/graph hits)
export async function getPoints(pointIds, collection) {
  if (!pointIds || pointIds.length === 0) return [];
  const result = await qdrantRequest(`/collections/${col(collection)}/points`, {
    method: 'POST',
    body: JSON.stringify({ ids: pointIds, with_payload: true, with_vector: false }),
  });
  return result.result || [];
}

// Update payload fields on existing points (partial update)
export async function updatePointPayload(pointIds, payload, collection) {
  const ids = Array.isArray(pointIds) ? pointIds : [pointIds];
  return qdrantRequest(`/collections/${col(collection)}/points/payload`, {
    method: 'POST',
    body: JSON.stringify({ payload, points: ids }),
  });
}

// Find points by exact payload field match
export async function findByPayload(field, value, extraFilter = {}, limit = 10, collection) {
  const must = [{ key: field, match: { value } }];
  for (const [key, val] of Object.entries(extraFilter)) {
    if (val !== undefined && val !== null) {
      if (typeof val === 'boolean') {
        must.push({ key, match: { value: val } });
      } else {
        must.push({ key, match: { value: val } });
      }
    }
  }

  const result = await qdrantRequest(`/collections/${col(collection)}/points/scroll`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { must },
      limit,
      with_payload: true,
    }),
  });
  return (result.result || {}).points || [];
}

// Compute effective confidence with time decay
export function computeEffectiveConfidence(payload) {
  if (!DECAY_TYPES.includes(payload.type)) return payload.confidence || 1.0;

  const baseConfidence = payload.confidence || 1.0;
  const lastAccess = payload.last_accessed_at || payload.created_at;
  if (!lastAccess) return baseConfidence;

  const daysSinceAccess = (Date.now() - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
  return baseConfidence * Math.pow(DECAY_FACTOR, daysSinceAccess);
}

// Get memory stats across the collection
export async function getMemoryStats(collection) {
  const c = col(collection);
  const info = await getCollectionInfo(collection);

  // Run all count queries in parallel
  const types = ['event', 'fact', 'decision', 'status'];
  const [activeResult, consolidatedResult, ...typeResults] = await Promise.all([
    qdrantRequest(`/collections/${c}/points/count`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { must: [{ key: 'active', match: { value: true } }] },
        exact: true,
      }),
    }),
    qdrantRequest(`/collections/${c}/points/count`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { must: [{ key: 'consolidated', match: { value: true } }] },
        exact: true,
      }),
    }),
    ...types.map(type =>
      qdrantRequest(`/collections/${c}/points/count`, {
        method: 'POST',
        body: JSON.stringify({
          filter: { must: [{ key: 'type', match: { value: type } }] },
          exact: true,
        }),
      })
    ),
  ]);

  const typeCounts = {};
  types.forEach((type, i) => {
    typeCounts[type] = typeResults[i].result?.count || 0;
  });

  return {
    total_memories: info.points_count,
    vectors_count: info.vectors_count,
    active: activeResult.result?.count || 0,
    superseded: (info.points_count || 0) - (activeResult.result?.count || 0),
    consolidated: consolidatedResult.result?.count || 0,
    by_type: typeCounts,
  };
}

/**
 * Batch update entity type in all Qdrant points where entities[].name matches.
 * Scrolls through all matching points and updates the entities array in chunks of 100.
 * @param {string} entityName - Entity name to find in payloads
 * @param {string} oldType - Current type to match
 * @param {string} newType - New type to assign
 * @returns {Promise<{ total_updated: number, total_scanned: number }>}
 */
export async function batchUpdateEntityType(entityName, oldType, newType) {
  let totalUpdated = 0;
  let totalScanned = 0;
  let nextOffset = null;
  const CHUNK_SIZE = 100;

  // Scroll through all points that have this entity name in their entities array
  do {
    const body = {
      limit: CHUNK_SIZE,
      with_payload: true,
      filter: {
        must: [
          {
            nested: {
              key: 'entities',
              filter: {
                must: [{ key: 'name', match: { value: entityName } }],
              },
            },
          },
        ],
      },
    };

    if (nextOffset) body.offset = nextOffset;

    const result = await qdrantRequest(`/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const scrollResult = result.result || {};
    const points = scrollResult.points || [];
    nextOffset = scrollResult.next_page_offset || null;

    totalScanned += points.length;

    // For each point, update the entities array if needed
    for (const point of points) {
      const entities = point.payload?.entities;
      if (!Array.isArray(entities)) continue;

      let changed = false;
      const updatedEntities = entities.map(e => {
        if (e.name === entityName && e.type === oldType) {
          changed = true;
          return { ...e, type: newType };
        }
        return e;
      });

      if (changed) {
        await updatePointPayload([point.id], { entities: updatedEntities });
        totalUpdated++;
      }
    }
  } while (nextOffset);

  return { total_updated: totalUpdated, total_scanned: totalScanned };
}

// --- Collection Management ---

/**
 * Create a new Qdrant collection with standard config and indexes.
 */
export async function createQdrantCollection(collectionName) {
  const embeddingDims = getEmbeddingDimensions();
  await qdrantRequest('/collections/' + collectionName, {
    method: 'PUT',
    body: JSON.stringify({
      vectors: { size: embeddingDims, distance: 'Cosine' },
      optimizers_config: { indexing_threshold: 100 },
    }),
  });

  // Create standard indexes
  const keywordFields = ['type', 'source_agent', 'client_id', 'category', 'importance', 'content_hash', 'key', 'subject', 'knowledge_category'];
  for (const field of keywordFields) {
    await qdrantRequest(`/collections/${collectionName}/index`, {
      method: 'PUT', body: JSON.stringify({ field_name: field, field_schema: 'keyword' }),
    });
  }
  await qdrantRequest(`/collections/${collectionName}/index`, { method: 'PUT', body: JSON.stringify({ field_name: 'active', field_schema: 'Bool' }) });
  await qdrantRequest(`/collections/${collectionName}/index`, { method: 'PUT', body: JSON.stringify({ field_name: 'confidence', field_schema: 'Float' }) });
  await qdrantRequest(`/collections/${collectionName}/index`, { method: 'PUT', body: JSON.stringify({ field_name: 'access_count', field_schema: 'Integer' }) });
  for (const field of ['created_at', 'last_accessed_at']) {
    await qdrantRequest(`/collections/${collectionName}/index`, {
      method: 'PUT', body: JSON.stringify({ field_name: field, field_schema: { type: 'datetime', is_tenant: false } }),
    });
  }
  await qdrantRequest(`/collections/${collectionName}/index`, { method: 'PUT', body: JSON.stringify({ field_name: 'entities[].name', field_schema: 'keyword' }) });

  return { name: collectionName, dimensions: embeddingDims };
}

/**
 * Delete a Qdrant collection.
 */
export async function deleteQdrantCollection(collectionName) {
  return qdrantRequest(`/collections/${collectionName}`, { method: 'DELETE' });
}

/**
 * List all Qdrant collections.
 */
export async function listQdrantCollections() {
  const result = await qdrantRequest('/collections');
  return (result.result || {}).collections || [];
}

export { DECAY_TYPES, qdrantRequest };
