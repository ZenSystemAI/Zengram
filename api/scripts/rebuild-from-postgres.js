#!/usr/bin/env node
/**
 * Rebuild Qdrant vectors from Postgres records.
 * Use this after a failed reindex that left Qdrant empty but Postgres intact.
 *
 * Usage: node scripts/rebuild-from-postgres.js
 */

try { await import('dotenv/config'); } catch (e) {}
import { initEmbeddings, embed, getEmbeddingDimensions } from '../src/services/embedders/interface.js';
import crypto from 'crypto';

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = 'shared_memories';
const BATCH_SIZE = 10;
const DELAY_MS = 200;

async function qdrantRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (QDRANT_API_KEY) headers['api-key'] = QDRANT_API_KEY;
  const res = await fetch(`${QDRANT_URL}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Qdrant ${options.method || 'GET'} ${path}: ${res.status} ${body}`);
  }
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('[rebuild] Initializing...');
  await initEmbeddings();
  const dims = getEmbeddingDimensions();
  console.log(`[rebuild] Embedding: ${process.env.EMBEDDING_PROVIDER}, ${dims} dims`);

  // Connect to Postgres
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: process.env.POSTGRES_URL });

  // Fetch all records from all 3 tables
  const records = [];

  const events = await pool.query('SELECT * FROM events ORDER BY created_at');
  for (const row of events.rows) {
    records.push({
      id: row.qdrant_point_id || crypto.randomUUID(),
      content: row.content,
      payload: {
        text: row.content,
        type: 'event',
        source_agent: row.source_agent,
        client_id: row.client_id || 'global',
        category: row.category || 'episodic',
        importance: row.importance || 'medium',
        content_hash: row.content_hash,
        active: true,
        confidence: 1.0,
        access_count: row.access_count || 0,
        created_at: row.created_at?.toISOString(),
        last_accessed_at: row.last_accessed_at?.toISOString() || row.created_at?.toISOString(),
        observed_by: row.observed_by || [row.source_agent],
      },
    });
  }

  const facts = await pool.query('SELECT * FROM facts ORDER BY created_at');
  for (const row of facts.rows) {
    records.push({
      id: row.qdrant_point_id || crypto.randomUUID(),
      content: row.content,
      payload: {
        text: row.content,
        type: 'fact',
        key: row.key,
        source_agent: row.source_agent,
        client_id: row.client_id || 'global',
        category: row.category || 'semantic',
        importance: row.importance || 'medium',
        content_hash: row.content_hash,
        active: row.active !== false,
        confidence: row.confidence || 1.0,
        access_count: row.access_count || 0,
        created_at: row.created_at?.toISOString(),
        last_accessed_at: row.last_accessed_at?.toISOString() || row.created_at?.toISOString(),
        observed_by: row.observed_by || [row.source_agent],
        superseded_by: row.superseded_by || null,
      },
    });
  }

  const statuses = await pool.query('SELECT * FROM statuses ORDER BY created_at');
  for (const row of statuses.rows) {
    records.push({
      id: row.qdrant_point_id || crypto.randomUUID(),
      content: row.content,
      payload: {
        text: row.content,
        type: 'status',
        subject: row.subject,
        source_agent: row.source_agent,
        client_id: row.client_id || 'global',
        category: row.category || 'procedural',
        importance: row.importance || 'medium',
        content_hash: row.content_hash,
        active: row.active !== false,
        confidence: row.confidence || 1.0,
        access_count: row.access_count || 0,
        created_at: row.created_at?.toISOString(),
        last_accessed_at: row.last_accessed_at?.toISOString() || row.created_at?.toISOString(),
        observed_by: row.observed_by || [row.source_agent],
        superseded_by: row.superseded_by || null,
      },
    });
  }

  await pool.end();
  console.log(`[rebuild] Loaded ${records.length} records from Postgres (${events.rows.length} events, ${facts.rows.length} facts, ${statuses.rows.length} statuses)`);

  // Embed and upsert in batches
  let done = 0;
  let errors = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const points = [];

    for (const rec of batch) {
      try {
        const vector = await embed(rec.content, 'store');
        points.push({ id: rec.id, vector, payload: rec.payload });
      } catch (err) {
        errors++;
        console.error(`[rebuild] Failed to embed ${rec.id}: ${err.message}`);
      }
    }

    if (points.length > 0) {
      await qdrantRequest(`/collections/${COLLECTION}/points`, {
        method: 'PUT',
        body: JSON.stringify({ points }),
      });
      done += points.length;
    }

    process.stdout.write(`\r[rebuild] Progress: ${done}/${records.length} (${errors} errors)`);
    if (i + BATCH_SIZE < records.length) await sleep(DELAY_MS);
  }

  console.log(`\n[rebuild] Complete. ${done} memories restored, ${errors} errors.`);
}

main().catch(err => { console.error('[rebuild] Fatal:', err); process.exit(1); });
