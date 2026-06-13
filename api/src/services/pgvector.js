// Vector store — a single `memories` table in Postgres with promoted hot-path
// columns (type, source_agent, client_id, content_hash, key, subject, active,
// created_at), a JSONB `payload` for everything else, and a `vector(N)` column
// indexed with HNSW for ANN search. Scoring uses the pgvector `<=>` cosine
// distance operator mapped to a [0,1] similarity.

import pg from 'pg';
import { getEmbeddingDimensions } from './embedders/interface.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

// Effective-confidence decay applied on read to fact- and status-type memories.
const DECAY_FACTOR = parseFloat(process.env.DECAY_FACTOR) || 0.98;
const DECAY_TYPES = ['fact', 'status'];

let pool = null;

export async function initPgvector() {
  const dims = getEmbeddingDimensions();

  pool = new pg.Pool({ connectionString: POSTGRES_URL });
  pool.on('error', (err) => console.error('[pgvector] Idle client error:', err.message));

  // Register the pgvector type as array-of-float so values round-trip cleanly.
  // Without this, pg returns the raw '[1,2,3]' string and upserts fail on type mismatch.
  const vectorTypeOid = await registerVectorType(pool);

  // Create extension + table (idempotent)
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      vector vector(${dims}),
      type TEXT NOT NULL,
      source_agent TEXT,
      client_id TEXT DEFAULT 'global',
      content_hash TEXT,
      key TEXT,
      subject TEXT,
      active BOOLEAN DEFAULT true,
      consolidated BOOLEAN DEFAULT false,
      importance TEXT,
      confidence REAL DEFAULT 1.0,
      access_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_accessed_at TIMESTAMPTZ,
      payload JSONB NOT NULL,
      collection TEXT DEFAULT 'shared_memories'
    )
  `);

  // Indexes — HNSW for vector ANN, btree for hot-path filters, GIN for JSONB entity filter.
  // HNSW creation is idempotent via IF NOT EXISTS but takes a moment on first create.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_vector_hnsw ON memories USING hnsw (vector vector_cosine_ops)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type) WHERE active = true`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_source_agent ON memories(source_agent) WHERE active = true`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_client_id ON memories(client_id) WHERE active = true`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key) WHERE key IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject) WHERE subject IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_consolidated ON memories(consolidated) WHERE consolidated = true`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_payload_entities ON memories USING GIN ((payload -> 'entities'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_collection ON memories(collection)`);

  console.log(`[pgvector] Table 'memories' ready (vector dims: ${dims})`);
}

// Register the vector OID so parameter binding works with float[] input.
async function registerVectorType(pool) {
  try {
    const { rows } = await pool.query("SELECT oid FROM pg_type WHERE typname = 'vector'");
    if (rows.length > 0) {
      const oid = rows[0].oid;
      pg.types.setTypeParser(oid, (val) => val);
      return oid;
    }
  } catch (e) {
    // Extension not yet installed — will be created by initPgvector
  }
  return null;
}

// Format a JS number array into pgvector literal syntax: [1.2, 3.4, ...]
function toVectorLiteral(arr) {
  return `[${arr.join(',')}]`;
}

// No-op — pgvector has no separate "entity index" concept (payload indexes are
// defined on table creation). Kept so callers can still treat it as a unified
// post-init step alongside other vector backends.
export async function ensureEntityIndex() {
  console.log('[pgvector] Payload indexes verified');
}

// --- CRUD ---

export async function upsertPoint(id, vector, payload, collection) {
  const col = collection || 'shared_memories';
  const vecLit = toVectorLiteral(vector);
  await pool.query(`
    INSERT INTO memories (
      id, vector, type, source_agent, client_id, content_hash,
      key, subject, active, consolidated, importance, confidence,
      access_count, created_at, last_accessed_at, payload, collection
    ) VALUES (
      $1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
    )
    ON CONFLICT (id) DO UPDATE SET
      vector = EXCLUDED.vector,
      type = EXCLUDED.type,
      source_agent = EXCLUDED.source_agent,
      client_id = EXCLUDED.client_id,
      content_hash = EXCLUDED.content_hash,
      key = EXCLUDED.key,
      subject = EXCLUDED.subject,
      active = EXCLUDED.active,
      consolidated = EXCLUDED.consolidated,
      importance = EXCLUDED.importance,
      confidence = EXCLUDED.confidence,
      access_count = EXCLUDED.access_count,
      last_accessed_at = EXCLUDED.last_accessed_at,
      payload = EXCLUDED.payload
  `, [
    id, vecLit, payload.type, payload.source_agent, payload.client_id || 'global',
    payload.content_hash, payload.key || null, payload.subject || null,
    payload.active !== false, payload.consolidated === true,
    payload.importance || 'medium', payload.confidence ?? 1.0,
    payload.access_count || 0, payload.created_at || new Date().toISOString(),
    payload.last_accessed_at || null, payload, col,
  ]);
}

// Atomically supersede the prior active fact/status for this key/subject and insert
// the new active row, under a per-key advisory lock so two concurrent writes can't
// both insert an active row. keyField is 'key' (fact) or 'subject' (status).
// supersedeFields are merged into the old row's JSONB ({ superseded_by, superseded_at, valid_to });
// the old row's active column AND JSONB active flag are both set false to stay consistent.
// Returns { supersededId } (null if there was no prior active row).
//
// NOTE: the INSERT column list below is kept in exact sync with upsertPoint above
// (a transaction needs its own client.query). If columns change, update both.
export async function supersedeAndInsert(keyField, keyValue, newId, vector, payload, supersedeFields, collection) {
  const col = collection || 'shared_memories';
  const vecLit = toVectorLiteral(vector);
  const column = keyField === 'key' ? 'key' : 'subject';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent writers for this exact key/subject value.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [keyField, keyValue]);

    const prior = await client.query(
      `SELECT id FROM memories
        WHERE ${column} = $1 AND active = true AND type = $2 AND collection = $3
        ORDER BY created_at DESC LIMIT 1`,
      [keyValue, payload.type, col]
    );
    let supersededId = null;
    if (prior.rows.length > 0) {
      supersededId = prior.rows[0].id;
      await client.query(
        `UPDATE memories SET active = false, payload = payload || $2::jsonb WHERE id = $1 AND collection = $3`,
        [supersededId, JSON.stringify({ active: false, ...supersedeFields }), col]
      );
    }
    // Insert the new active row inside the same transaction (mirror upsertPoint's columns).
    await client.query(
      `INSERT INTO memories (
        id, vector, type, source_agent, client_id, content_hash,
        key, subject, active, consolidated, importance, confidence,
        access_count, created_at, last_accessed_at, payload, collection
      ) VALUES (
        $1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
      )
      ON CONFLICT (id) DO UPDATE SET
        vector = EXCLUDED.vector,
        payload = EXCLUDED.payload,
        active = EXCLUDED.active`,
      [
        newId, vecLit, payload.type, payload.source_agent, payload.client_id || 'global',
        payload.content_hash, payload.key || null, payload.subject || null,
        payload.active !== false, payload.consolidated === true,
        payload.importance || 'medium', payload.confidence ?? 1.0,
        payload.access_count || 0, payload.created_at || new Date().toISOString(),
        payload.last_accessed_at || null, payload, col,
      ]
    );
    await client.query('COMMIT');
    return { supersededId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Search ---
//
// Filter shape (from callers):
//   filter: { type, source_agent, client_id, category, importance, active, ... }
//   nestedFilters: [{ arrayField: 'entities', key: 'name', value: 'Alice' }]
//   rangeFilters: [{ key: 'created_at', range: { gte, lte } }]
export async function searchPoints(vector, filter = {}, limit = 10, nestedFilters = [], rangeFilters = [], collection) {
  const col = collection || 'shared_memories';
  const vecLit = toVectorLiteral(vector);
  const params = [vecLit, col];
  const wheres = ['collection = $2'];
  let pIdx = 3;

  // Promoted columns — direct btree filtering
  const promoted = new Set(['type', 'source_agent', 'client_id', 'content_hash', 'key', 'subject', 'active', 'consolidated']);
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    if (promoted.has(key)) {
      wheres.push(`${key} = $${pIdx++}`);
      params.push(value);
    } else {
      // Fall back to JSONB lookup for other fields (category, importance, knowledge_category, etc.)
      wheres.push(`payload ->> $${pIdx++} = $${pIdx++}`);
      params.push(key, String(value));
    }
  }

  // Nested filters: entities[].name = 'X' → payload -> 'entities' @> '[{"name": "X"}]'
  for (const nf of nestedFilters) {
    wheres.push(`payload -> $${pIdx++} @> $${pIdx++}::jsonb`);
    params.push(nf.arrayField, JSON.stringify([{ [nf.key]: nf.value }]));
  }

  // Range filters
  for (const rf of rangeFilters) {
    if (rf.range.gte !== undefined) {
      if (promoted.has(rf.key) || rf.key === 'created_at') {
        wheres.push(`${rf.key} >= $${pIdx++}`);
        params.push(rf.range.gte);
      } else {
        // NULL-tolerant: a row whose payload lacks this key passes the filter,
        // so events/decisions (no valid_from) aren't silently dropped by at_time.
        wheres.push(`((payload ->> $${pIdx}) IS NULL OR (payload ->> $${pIdx})::timestamptz >= $${pIdx + 1})`);
        params.push(rf.key, rf.range.gte);
        pIdx += 2;
      }
    }
    if (rf.range.lte !== undefined) {
      if (promoted.has(rf.key) || rf.key === 'created_at') {
        wheres.push(`${rf.key} <= $${pIdx++}`);
        params.push(rf.range.lte);
      } else {
        // NULL-tolerant: see gte branch above.
        wheres.push(`((payload ->> $${pIdx}) IS NULL OR (payload ->> $${pIdx})::timestamptz <= $${pIdx + 1})`);
        params.push(rf.key, rf.range.lte);
        pIdx += 2;
      }
    }
  }

  // Cosine similarity: pgvector '<=>' is cosine distance (0 = identical, 2 = opposite).
  // We want a similarity score in [0,1] range matching the vector store's behavior, so: 1 - (distance / 2).
  // Score threshold 0.3 matches the old vector store search_points score_threshold.
  const sql = `
    SELECT id, payload, 1 - (vector <=> $1::vector) / 2 AS score
    FROM memories
    WHERE ${wheres.join(' AND ')}
      AND 1 - (vector <=> $1::vector) / 2 >= 0.3
    ORDER BY vector <=> $1::vector
    LIMIT $${pIdx}
  `;
  params.push(limit);

  const result = await pool.query(sql, params);
  return result.rows.map(r => ({ id: r.id, score: parseFloat(r.score), payload: r.payload }));
}

// --- Scroll (paginated scan) ---
export async function scrollPoints(filter = {}, limit = 50, offset = null, collection) {
  const col = collection || 'shared_memories';
  const params = [col];
  const wheres = ['collection = $1'];
  let pIdx = 2;

  const promoted = new Set(['type', 'source_agent', 'client_id', 'content_hash', 'key', 'subject', 'active', 'consolidated']);

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    if (key === 'created_after') {
      wheres.push(`created_at >= $${pIdx++}`);
      params.push(value);
    } else if (promoted.has(key)) {
      wheres.push(`${key} = $${pIdx++}`);
      params.push(value);
    } else {
      wheres.push(`payload ->> $${pIdx++} = $${pIdx++}`);
      params.push(key, String(value));
    }
  }

  // Offset here is a keyset token: the created_at + id of the last row. Simpler
  // than the vector store's opaque token, and stable across writes since (created_at, id)
  // is unique enough in practice.
  if (offset) {
    wheres.push(`(created_at, id) < ($${pIdx++}::timestamptz, $${pIdx++})`);
    params.push(offset.created_at, offset.id);
  }

  const sql = `
    SELECT id, payload, created_at
    FROM memories
    WHERE ${wheres.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT $${pIdx}
  `;
  params.push(limit);

  const result = await pool.query(sql, params);
  const points = result.rows.map(r => ({ id: r.id, payload: r.payload }));

  // Return the keyset for the next page
  const next_page_offset = points.length === limit && result.rows.length > 0
    ? { created_at: result.rows[result.rows.length - 1].created_at, id: result.rows[result.rows.length - 1].id }
    : null;

  return { points, next_page_offset };
}

// --- Point lookups ---

export async function getPoint(pointId, collection) {
  const col = collection || 'shared_memories';
  const result = await pool.query(
    'SELECT id, payload FROM memories WHERE id = $1 AND collection = $2',
    [pointId, col]
  );
  if (result.rows.length === 0) return null;
  return { id: result.rows[0].id, payload: result.rows[0].payload };
}

export async function getPoints(pointIds, collection) {
  if (!pointIds || pointIds.length === 0) return [];
  const col = collection || 'shared_memories';
  const result = await pool.query(
    'SELECT id, payload FROM memories WHERE id = ANY($1) AND collection = $2',
    [pointIds, col]
  );
  return result.rows.map(r => ({ id: r.id, payload: r.payload }));
}

// --- Payload update (partial) ---
// Merges the provided fields into the stored payload, and if the update touches
// a promoted column we rewrite that column too so future queries stay fast.
export async function updatePointPayload(pointIds, payloadUpdate, collection) {
  const ids = Array.isArray(pointIds) ? pointIds : [pointIds];
  const col = collection || 'shared_memories';

  // Build SET clause: always merge JSONB, plus rewrite any promoted columns that appear in the update.
  const promoted = ['type', 'source_agent', 'client_id', 'content_hash', 'key', 'subject', 'active', 'consolidated', 'importance', 'confidence', 'access_count', 'last_accessed_at'];
  const sets = ['payload = payload || $2::jsonb'];
  const params = [ids, JSON.stringify(payloadUpdate), col];
  let pIdx = 4;

  for (const field of promoted) {
    if (payloadUpdate[field] !== undefined) {
      sets.push(`${field} = $${pIdx++}`);
      params.push(payloadUpdate[field]);
    }
  }

  const sql = `UPDATE memories SET ${sets.join(', ')} WHERE id = ANY($1) AND collection = $3`;
  await pool.query(sql, params);
}

// Atomically increment access_count and stamp last_accessed_at for many ids in
// one statement. Bumps both the promoted column and the mirrored payload keys so
// the two stay consistent. Used on the hot search path; replaces a read-then-write
// loop and removes the access_count race.
export async function bumpAccessCounts(pointIds, now, collection) {
  const ids = Array.isArray(pointIds) ? pointIds : [pointIds];
  if (ids.length === 0) return;
  const col = collection || 'shared_memories';
  await pool.query(
    `UPDATE memories
       SET access_count = access_count + 1,
           last_accessed_at = $2,
           payload = payload || jsonb_build_object(
             'access_count', COALESCE((payload->>'access_count')::int, 0) + 1,
             'last_accessed_at', $2::text
           )
     WHERE id = ANY($1) AND collection = $3`,
    [ids, now, col]
  );
}

// --- Find by exact payload match ---
export async function findByPayload(field, value, extraFilter = {}, limit = 10, collection) {
  const col = collection || 'shared_memories';
  const params = [col];
  const wheres = ['collection = $1'];
  let pIdx = 2;

  const promoted = new Set(['type', 'source_agent', 'client_id', 'content_hash', 'key', 'subject', 'active', 'consolidated']);

  if (promoted.has(field)) {
    wheres.push(`${field} = $${pIdx++}`);
    params.push(value);
  } else {
    wheres.push(`payload ->> $${pIdx++} = $${pIdx++}`);
    params.push(field, String(value));
  }

  for (const [key, val] of Object.entries(extraFilter)) {
    if (val === undefined || val === null) continue;
    if (promoted.has(key)) {
      wheres.push(`${key} = $${pIdx++}`);
      params.push(val);
    } else {
      wheres.push(`payload ->> $${pIdx++} = $${pIdx++}`);
      params.push(key, String(val));
    }
  }

  const sql = `SELECT id, payload FROM memories WHERE ${wheres.join(' AND ')} ORDER BY created_at DESC LIMIT $${pIdx}`;
  params.push(limit);

  const result = await pool.query(sql, params);
  return result.rows.map(r => ({ id: r.id, payload: r.payload }));
}

// --- Effective confidence (pure function) ---
export function computeEffectiveConfidence(payload) {
  if (!DECAY_TYPES.includes(payload.type)) return payload.confidence || 1.0;
  const baseConfidence = payload.confidence || 1.0;
  const lastAccess = payload.last_accessed_at || payload.created_at;
  if (!lastAccess) return baseConfidence;
  const daysSinceAccess = (Date.now() - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
  return baseConfidence * Math.pow(DECAY_FACTOR, daysSinceAccess);
}

// --- Stats ---
export async function getMemoryStats(collection) {
  const col = collection || 'shared_memories';
  const result = await pool.query(`
    SELECT
      COUNT(*) AS total_memories,
      COUNT(*) FILTER (WHERE active = true) AS active,
      COUNT(*) FILTER (WHERE consolidated = true) AS consolidated,
      COUNT(*) FILTER (WHERE type = 'event') AS event_count,
      COUNT(*) FILTER (WHERE type = 'fact') AS fact_count,
      COUNT(*) FILTER (WHERE type = 'decision') AS decision_count,
      COUNT(*) FILTER (WHERE type = 'status') AS status_count
    FROM memories WHERE collection = $1
  `, [col]);

  const r = result.rows[0];
  const total = parseInt(r.total_memories);
  const active = parseInt(r.active);
  return {
    total_memories: total,
    vectors_count: total,
    active,
    superseded: total - active,
    consolidated: parseInt(r.consolidated),
    by_type: {
      event: parseInt(r.event_count),
      fact: parseInt(r.fact_count),
      decision: parseInt(r.decision_count),
      status: parseInt(r.status_count),
    },
  };
}

// --- Batch entity type update (used by entity reclassification) ---
export async function batchUpdateEntityType(entityName, oldType, newType) {
  // Find all memories whose payload.entities contains {name: entityName, type: oldType}
  const result = await pool.query(`
    SELECT id, payload FROM memories
    WHERE payload -> 'entities' @> $1::jsonb
  `, [JSON.stringify([{ name: entityName, type: oldType }])]);

  let totalUpdated = 0;
  for (const row of result.rows) {
    const entities = Array.isArray(row.payload.entities) ? row.payload.entities : [];
    const updated = entities.map(e =>
      (e.name === entityName && e.type === oldType) ? { ...e, type: newType } : e
    );
    const newPayload = { ...row.payload, entities: updated };
    await pool.query(
      'UPDATE memories SET payload = $1::jsonb WHERE id = $2',
      [JSON.stringify(newPayload), row.id]
    );
    totalUpdated++;
  }

  return { total_updated: totalUpdated, total_scanned: result.rows.length };
}

// --- Collection management ---
// Collections are a `collection` column value on the memories row, not a
// physical table — so creation is implicit (first insert with a new value).

export async function createCollection(collectionName) {
  const dims = getEmbeddingDimensions();
  return { name: collectionName, dimensions: dims };
}

export async function deleteCollection(collectionName) {
  await pool.query('DELETE FROM memories WHERE collection = $1', [collectionName]);
  return { deleted: true };
}

export async function listStoredCollections() {
  const result = await pool.query('SELECT collection AS name, COUNT(*) AS points FROM memories GROUP BY collection');
  return result.rows.map(r => ({ name: r.name, points_count: parseInt(r.points) }));
}

export async function getCollectionInfo(collection) {
  const col = collection || 'shared_memories';
  const result = await pool.query(
    'SELECT COUNT(*) AS points_count FROM memories WHERE collection = $1',
    [col]
  );
  return { points_count: parseInt(result.rows[0].points_count), vectors_count: parseInt(result.rows[0].points_count) };
}

export { DECAY_TYPES };
