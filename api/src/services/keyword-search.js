// BM25 keyword search service (Postgres tsvector + GIN + ts_rank_cd).
// Provides the keyword retrieval path that runs alongside vector search;
// results are fused via RRF at the route layer.

let store = null;

export function initKeywordSearch(storeInstance) {
  store = storeInstance;
  if (store) console.log('[keyword-search] Initialized (postgres)');
  else console.log('[keyword-search] Disabled (no structured store)');
}

export function isKeywordSearchAvailable() {
  return store !== null;
}

// Fire-and-forget — failures are logged by caller but don't block the write path.
export async function indexMemory(memoryId, content, metadata = {}) {
  if (!isKeywordSearchAvailable()) return;
  const { client_id, source_agent, type } = metadata;
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
}

export async function deactivateMemory(memoryId) {
  if (!isKeywordSearchAvailable()) return;
  await store.pool.query(
    `UPDATE memory_search SET active = false WHERE memory_id = $1`,
    [memoryId]
  );
}

export async function keywordSearch(queryText, filters = {}, limit = 20) {
  if (!isKeywordSearchAvailable()) return [];
  if (!queryText || queryText.trim().length === 0) return [];

  // plainto_tsquery handles natural language — no special syntax needed.
  let sql = `
    SELECT memory_id,
           ts_rank_cd(content_tsv, plainto_tsquery('english', $1)) AS rank
    FROM memory_search
    WHERE content_tsv @@ plainto_tsquery('english', $1)
      AND active = true
  `;
  const params = [queryText];
  let i = 2;

  if (filters.client_id) { sql += ` AND client_id = $${i++}`; params.push(filters.client_id); }
  if (filters.type) { sql += ` AND type = $${i++}`; params.push(filters.type); }
  if (filters.source_agent) { sql += ` AND source_agent = $${i++}`; params.push(filters.source_agent); }

  sql += ` ORDER BY rank DESC LIMIT $${i++}`;
  params.push(limit);

  const result = await store.pool.query(sql, params);
  return result.rows;
}

export async function getKeywordIndexCount() {
  if (!isKeywordSearchAvailable()) return 0;
  const result = await store.pool.query(
    `SELECT COUNT(*) AS count FROM memory_search WHERE active = true`
  );
  return parseInt(result.rows[0].count);
}
