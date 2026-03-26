// BM25 / Full-Text Keyword Search Service
// Postgres: tsvector + GIN index with ts_rank_cd
// SQLite: FTS5 virtual table with MATCH
// Provides a second retrieval path alongside vector search for exact term matching.

let store = null;
let backend = null; // 'postgres' | 'sqlite' | null

export function initKeywordSearch(storeInstance, backendType) {
  store = storeInstance;
  backend = backendType;
  if (backend === 'postgres' || backend === 'sqlite') {
    console.log(`[keyword-search] Initialized (${backend})`);
  } else {
    console.log('[keyword-search] Disabled (no supported structured store)');
  }
}

export function isKeywordSearchAvailable() {
  return store !== null && (backend === 'postgres' || backend === 'sqlite');
}

/**
 * Index a memory for keyword search. Called on memory store.
 * Fire-and-forget — failures are logged but don't block the write path.
 */
export async function indexMemory(memoryId, content, metadata = {}) {
  if (!isKeywordSearchAvailable()) return;

  const { client_id, source_agent, type } = metadata;

  if (backend === 'postgres') {
    await store.pool.query(
      `INSERT INTO memory_search (memory_id, content, client_id, source_agent, type, active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (memory_id) DO UPDATE SET
         content = EXCLUDED.content,
         client_id = EXCLUDED.client_id,
         source_agent = EXCLUDED.source_agent,
         type = EXCLUDED.type,
         active = true`,
      [memoryId, content, client_id || 'global', source_agent || null, type || null]
    );
  } else if (backend === 'sqlite') {
    store.db.prepare(
      `INSERT OR REPLACE INTO memory_search_fts (memory_id, content, client_id, type)
       VALUES (?, ?, ?, ?)`
    ).run(memoryId, content, client_id || 'global', type || null);
  }
}

/**
 * Deactivate a memory in the keyword index (on supersede or delete).
 */
export async function deactivateMemory(memoryId) {
  if (!isKeywordSearchAvailable()) return;

  if (backend === 'postgres') {
    await store.pool.query(
      `UPDATE memory_search SET active = false WHERE memory_id = $1`,
      [memoryId]
    );
  } else if (backend === 'sqlite') {
    // FTS5 doesn't support active flag — delete the row
    store.db.prepare(
      `DELETE FROM memory_search_fts WHERE memory_id = ?`
    ).run(memoryId);
  }
}

/**
 * Full-text keyword search using BM25-like ranking.
 *
 * @param {string} queryText - Natural language query
 * @param {object} filters - { client_id, type, source_agent }
 * @param {number} limit - Max results
 * @returns {Array<{memory_id: string, rank: number}>} Results sorted by text relevance
 */
export async function keywordSearch(queryText, filters = {}, limit = 20) {
  if (!isKeywordSearchAvailable()) return [];
  if (!queryText || queryText.trim().length === 0) return [];

  if (backend === 'postgres') {
    return postgresKeywordSearch(queryText, filters, limit);
  } else if (backend === 'sqlite') {
    return sqliteKeywordSearch(queryText, filters, limit);
  }

  return [];
}

async function postgresKeywordSearch(queryText, filters, limit) {
  // plainto_tsquery handles natural language — no special syntax needed
  let sql = `
    SELECT memory_id,
           ts_rank_cd(content_tsv, plainto_tsquery('english', $1)) AS rank
    FROM memory_search
    WHERE content_tsv @@ plainto_tsquery('english', $1)
      AND active = true
  `;
  const params = [queryText];
  let i = 2;

  if (filters.client_id) {
    sql += ` AND client_id = $${i++}`;
    params.push(filters.client_id);
  }
  if (filters.type) {
    sql += ` AND type = $${i++}`;
    params.push(filters.type);
  }
  if (filters.source_agent) {
    sql += ` AND source_agent = $${i++}`;
    params.push(filters.source_agent);
  }

  sql += ` ORDER BY rank DESC LIMIT $${i++}`;
  params.push(limit);

  const result = await store.pool.query(sql, params);
  return result.rows; // [{memory_id, rank}]
}

function sqliteKeywordSearch(queryText, filters, limit) {
  // FTS5 MATCH query — escape special characters
  const safeQuery = queryText.replace(/['"*()]/g, ' ').trim();
  if (!safeQuery) return [];

  let sql = `
    SELECT memory_id, rank
    FROM memory_search_fts
    WHERE content MATCH ?
  `;
  const params = [safeQuery];

  if (filters.client_id) {
    sql += ` AND client_id = ?`;
    params.push(filters.client_id);
  }
  if (filters.type) {
    sql += ` AND type = ?`;
    params.push(filters.type);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);

  return store.db.prepare(sql).all(...params);
}

/**
 * Get count of indexed memories (for stats).
 */
export async function getKeywordIndexCount() {
  if (!isKeywordSearchAvailable()) return 0;

  if (backend === 'postgres') {
    const result = await store.pool.query(
      `SELECT COUNT(*) AS count FROM memory_search WHERE active = true`
    );
    return parseInt(result.rows[0].count);
  } else if (backend === 'sqlite') {
    const row = store.db.prepare(
      `SELECT COUNT(*) AS count FROM memory_search_fts`
    ).get();
    return row.count;
  }

  return 0;
}
