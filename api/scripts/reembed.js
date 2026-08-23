#!/usr/bin/env node
// Re-embed-in-place: swap the embedding model without losing data.
//
// Reads every memory's text, re-embeds it with the CURRENTLY CONFIGURED embedding
// provider/model (EMBEDDING_PROVIDER + its env), and writes the new vector back to
// the pgvector `memories.vector` column. Handles a dimensionality change by
// dropping the HNSW index, re-typing the column to the new vector(N), re-embedding,
// then rebuilding the index.
//
// Run with the same POSTGRES_URL and embedding env the API uses:
//   node api/scripts/reembed.js            # dry-run
//   node api/scripts/reembed.js --commit   # apply
//
// Flags:
//   --commit            actually write (default: dry-run)
//   --concurrency N     parallel embed calls (default: 4)
//   --collection NAME   only re-embed one collection (default: all)
//   --limit N           cap rows processed (testing)
//
// Safety: dry-run by default; idempotent; re-runnable. It only rewrites the
// vector column and the HNSW index — payloads, BM25 index, and entities are
// untouched. Take a DB snapshot before a dimensionality change.

import pg from 'pg';
import { initEmbeddings, embed, getEmbeddingDimensions } from '../src/services/embedders/interface.js';
import { errorSummary } from '../src/lib/log.js';

const COMMIT = process.argv.includes('--commit');
const argVal = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const CONCURRENCY = Math.max(1, parseInt(argVal('--concurrency', '4')) || 4);
const ONLY_COLLECTION = argVal('--collection', null);
const LIMIT = parseInt(argVal('--limit', '0')) || 0;

const POSTGRES_URL = process.env.POSTGRES_URL;
if (!POSTGRES_URL) {
  console.error('[reembed] POSTGRES_URL is not set — refusing to run without an explicit DSN.');
  process.exit(1);
}

function vecLiteral(arr) { return `[${arr.join(',')}]`; }
function textOf(payload) {
  return (payload && (payload.text || payload.content || payload.note || payload.title)) || '';
}

async function currentColumnDims(pool) {
  // Sample an existing vector and count its components. Returns null if empty.
  const { rows } = await pool.query(
    `SELECT vector::text AS v FROM memories WHERE vector IS NOT NULL LIMIT 1`
  );
  if (!rows.length || !rows[0].v) return null;
  return rows[0].v.slice(1, -1).split(',').length;
}

async function main() {
  console.log(`[reembed] ${COMMIT ? 'COMMIT' : 'DRY-RUN'} mode (concurrency=${CONCURRENCY})`);
  await initEmbeddings();
  const targetDims = getEmbeddingDimensions();
  console.log(`[reembed] Provider: ${process.env.EMBEDDING_PROVIDER || 'openai'}, target dims: ${targetDims}`);

  const pool = new pg.Pool({ connectionString: POSTGRES_URL });
  pool.on('error', (e) => console.error('[reembed] idle client error: %s', errorSummary(e)));

  const existingDims = await currentColumnDims(pool);
  const dimsChange = existingDims != null && existingDims !== targetDims;
  console.log(`[reembed] Existing column dims: ${existingDims ?? 'unknown/empty'}${dimsChange ? ` → CHANGING to ${targetDims}` : ''}`);

  const where = ['1=1'];
  const params = [];
  if (ONLY_COLLECTION) { params.push(ONLY_COLLECTION); where.push(`collection = $${params.length}`); }
  let sql = `SELECT id, payload FROM memories WHERE ${where.join(' AND ')} ORDER BY created_at DESC`;
  if (LIMIT) sql += ` LIMIT ${LIMIT}`;

  const { rows } = await pool.query(sql, params);
  const withText = rows.filter(r => textOf(r.payload).trim());
  const skipped = rows.length - withText.length;
  console.log(`[reembed] ${rows.length} memories (${withText.length} have text, ${skipped} skipped)`);

  if (!COMMIT) {
    console.log(`[reembed] DRY-RUN: would re-embed ${withText.length} memories at ${targetDims} dims.`);
    if (dimsChange) {
      console.log(`[reembed] DRY-RUN: would drop idx_memories_vector_hnsw, re-type vector→vector(${targetDims}), then rebuild HNSW.`);
    }
    await pool.end();
    return;
  }

  // Dimensionality change: drop index + re-type column (blanks vectors), then refill.
  if (dimsChange) {
    console.log(`[reembed] Dropping HNSW index and re-typing vector column to vector(${targetDims})…`);
    await pool.query(`DROP INDEX IF EXISTS idx_memories_vector_hnsw`);
    await pool.query(`ALTER TABLE memories ALTER COLUMN vector TYPE vector(${targetDims}) USING NULL::vector(${targetDims})`);
  }

  let done = 0, failed = 0;
  const failures = [];
  // Simple bounded-concurrency worker pool over the row list.
  let cursor = 0;
  async function worker() {
    while (cursor < withText.length) {
      const idx = cursor++;
      const row = withText[idx];
      try {
        const vector = await embed(textOf(row.payload), 'store');
        await pool.query(`UPDATE memories SET vector = $1::vector WHERE id = $2`, [vecLiteral(vector), row.id]);
        done++;
        if (done % 50 === 0) console.log(`[reembed] ${done}/${withText.length} re-embedded…`);
      } catch (e) {
        failed++;
        failures.push({ id: row.id, error: errorSummary(e) });
        console.error('[reembed] FAILED %s: %s', row.id, errorSummary(e));
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Rebuild the HNSW index (always after a dims change; idempotent otherwise).
  if (dimsChange) {
    console.log(`[reembed] Rebuilding HNSW index…`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_vector_hnsw ON memories USING hnsw (vector vector_cosine_ops)`);
  }
  await pool.query(`ANALYZE memories`);

  console.log(`[reembed] Complete: ${done} re-embedded, ${failed} failed, ${skipped} skipped (no text).`);
  if (failures.length) console.log(`[reembed] failures: ${JSON.stringify(failures.slice(0, 20), null, 2)}`);
  if (dimsChange && failed > 0) {
    console.warn(`[reembed] WARNING: ${failed} rows have NULL vectors after a dims change — re-run to fill them.`);
  }
  await pool.end();
}

main().catch((e) => { console.error('[reembed] fatal: %s', errorSummary(e)); process.exit(1); });
