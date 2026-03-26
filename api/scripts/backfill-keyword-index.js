#!/usr/bin/env node
/**
 * Backfill keyword search index from existing Qdrant memories.
 * Scrolls all active points and inserts their text into the memory_search table
 * for BM25/full-text keyword retrieval.
 *
 * Usage: node api/scripts/backfill-keyword-index.js
 * Requires: .env configured with QDRANT_URL, STRUCTURED_STORE (postgres|sqlite)
 */

try { await import('dotenv/config'); } catch (e) { /* dotenv not needed in Docker */ }
import { initQdrant, scrollPoints } from '../src/services/qdrant.js';
import { initStore, _getStoreInstance, getBackendType } from '../src/services/stores/interface.js';
import { initKeywordSearch, indexMemory, isKeywordSearchAvailable } from '../src/services/keyword-search.js';
import { initEmbeddings } from '../src/services/embedders/interface.js';

async function backfill() {
  console.log('[backfill] Starting keyword index backfill...');

  // Initialize services
  await initEmbeddings();
  await initQdrant();
  await initStore();
  initKeywordSearch(_getStoreInstance(), getBackendType());

  if (!isKeywordSearchAvailable()) {
    console.error('[backfill] Keyword search not available. Need postgres or sqlite backend.');
    process.exit(1);
  }

  let processed = 0;
  let indexed = 0;
  let skipped = 0;
  let errors = 0;
  let offset = null;

  while (true) {
    const result = await scrollPoints({ active: true }, 100, offset);
    const points = result.points || [];

    if (points.length === 0) break;

    for (const point of points) {
      processed++;
      const p = point.payload;

      if (!p || !p.text) {
        skipped++;
        continue;
      }

      try {
        await indexMemory(point.id, p.text, {
          client_id: p.client_id || 'global',
          source_agent: p.source_agent || null,
          type: p.type || null,
        });
        indexed++;
      } catch (e) {
        errors++;
        if (errors <= 5) {
          console.error(`[backfill] Error indexing ${point.id}: ${e.message}`);
        }
      }

      if (processed % 100 === 0) {
        console.log(`[backfill] Progress: ${processed} processed, ${indexed} indexed, ${skipped} skipped, ${errors} errors`);
      }
    }

    offset = result.next_page_offset;
    if (!offset) break;
  }

  console.log(`[backfill] Complete: ${processed} processed, ${indexed} indexed, ${skipped} skipped, ${errors} errors`);
  process.exit(0);
}

backfill().catch(err => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
