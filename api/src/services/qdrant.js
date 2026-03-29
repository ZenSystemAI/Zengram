import { getEmbeddingDimensions } from './embedders/interface.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = 'shared_memories';

// Memory decay config
const DECAY_FACTOR = parseFloat(process.env.DECAY_FACTOR) || 0.98;
const DECAY_TYPES = ['fact', 'status']; // events and decisions are historical — don't decay

const QDRANT_TIMEOUT_MS = parseInt(process.env.QDRANT_TIMEOUT_MS) || 10000;

async function qdrantRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (QDRANT_API_KEY) headers['api-key'] = QDRANT_API_KEY;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QDRANT_TIMEOUT_MS);
  try {
    const res = await fetch(`${QDRANT_URL}${path}`, { ...options, headers: { ...headers, ...options.headers }, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Qdrant ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Qdrant request timed out after ${QDRANT_TIMEOUT_MS}ms: ${options.method || 'GET'} ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
      body: JSON.stringify({ field_name: field, field_schema: 'Keyword' }),
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
    { field_name: 'key', field_schema: 'Keyword' },
    { field_name: 'subject', field_schema: 'Keyword' },
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

export async function upsertPoint(id, vector, payload) {
  return qdrantRequest(`/collections/${COLLECTION}/points`, {
    method: 'PUT',
    body: JSON.stringify({
      points: [{ id, vector, payload }],
    }),
  });
}

export async function searchPoints(vector, filter = {}, limit = 10, nestedFilters = []) {
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

  if (must.length > 0) {
    body.filter = { must };
  }

  const result = await qdrantRequest(`/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return result.result || [];
}

export async function scrollPoints(filter = {}, limit = 50, offset = null) {
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

  const result = await qdrantRequest(`/collections/${COLLECTION}/points/scroll`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return result.result || {};
}

export async function getCollectionInfo() {
  const result = await qdrantRequest(`/collections/${COLLECTION}`);
  return result.result;
}

// Fetch a single point by ID
export async function getPoint(pointId) {
  const result = await qdrantRequest(`/collections/${COLLECTION}/points/${pointId}`);
  return result.result || null;
}

// Batch retrieve points by IDs (for RRF fusion — fetch payloads for keyword/graph hits)
export async function getPoints(pointIds) {
  if (!pointIds || pointIds.length === 0) return [];
  const result = await qdrantRequest(`/collections/${COLLECTION}/points`, {
    method: 'POST',
    body: JSON.stringify({ ids: pointIds, with_payload: true, with_vector: false }),
  });
  return result.result || [];
}

// Update payload fields on existing points (partial update)
export async function updatePointPayload(pointIds, payload) {
  const ids = Array.isArray(pointIds) ? pointIds : [pointIds];
  return qdrantRequest(`/collections/${COLLECTION}/points/payload`, {
    method: 'POST',
    body: JSON.stringify({ payload, points: ids }),
  });
}

// Find points by exact payload field match
export async function findByPayload(field, value, extraFilter = {}, limit = 10) {
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

  const result = await qdrantRequest(`/collections/${COLLECTION}/points/scroll`, {
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
export async function getMemoryStats() {
  const info = await getCollectionInfo();

  // Run all count queries in parallel
  const types = ['event', 'fact', 'decision', 'status'];
  const [activeResult, consolidatedResult, ...typeResults] = await Promise.all([
    qdrantRequest(`/collections/${COLLECTION}/points/count`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { must: [{ key: 'active', match: { value: true } }] },
        exact: true,
      }),
    }),
    qdrantRequest(`/collections/${COLLECTION}/points/count`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { must: [{ key: 'consolidated', match: { value: true } }] },
        exact: true,
      }),
    }),
    ...types.map(type =>
      qdrantRequest(`/collections/${COLLECTION}/points/count`, {
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

export { DECAY_TYPES };
