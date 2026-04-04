import { Router } from 'express';
import { scrollPoints, getPoint, updatePointPayload } from '../services/qdrant.js';
import { _getStoreInstance, isStoreAvailable, isEntityStoreAvailable, listEntities } from '../services/stores/interface.js';
import { isKeywordSearchAvailable } from '../services/keyword-search.js';

export const reconcileRouter = Router();

/**
 * POST /reconcile — Run data layer reconciliation
 * Finds and optionally fixes drift between Qdrant, Postgres, and keyword index.
 *
 * Body: { dry_run: true (default), fix_keyword_orphans: true, fix_entity_garbage: true }
 */
reconcileRouter.post('/', async (req, res) => {
  try {
    const isDryRun = req.body.dry_run !== false;
    const fixKeywordOrphans = req.body.fix_keyword_orphans !== false;
    const fixEntityGarbage = req.body.fix_entity_garbage !== false;

    const report = {
      dry_run: isDryRun,
      qdrant_orphans: { count: 0, ids: [] },
      keyword_orphans: { count: 0, cleaned: 0 },
      entity_garbage: { count: 0, cleaned: 0, samples: [] },
      entity_duplicates: { count: 0, samples: [] },
    };

    // --- 1. Find Qdrant vectors missing from Postgres ---
    if (isStoreAvailable()) {
      const store = _getStoreInstance();
      if (store?.pool) {
        // Get all active Qdrant point IDs by scrolling
        const qdrantIds = new Set();
        let offset = null;
        let batch = 0;
        do {
          const result = await scrollPoints({ active: true }, 100, offset);
          const points = result.points || [];
          for (const p of points) qdrantIds.add(p.id);
          offset = result.next_page_offset || null;
          batch++;
          if (batch > 50) break; // safety: max 5000 points
        } while (offset);

        // Check which IDs exist in Postgres events/facts/statuses
        // Postgres uses integer auto-increment, not UUIDs — so we can't directly
        // cross-reference. Instead, check content_hash overlap.
        const pgHashes = new Set();
        const hashResults = await Promise.all([
          store.pool.query('SELECT content_hash FROM events'),
          store.pool.query('SELECT content_hash FROM facts'),
          store.pool.query('SELECT content_hash FROM statuses'),
        ]);
        for (const r of hashResults) {
          for (const row of r.rows) {
            if (row.content_hash) pgHashes.add(row.content_hash);
          }
        }

        // Find Qdrant points whose content_hash is not in any Postgres table
        let orphanCheckCount = 0;
        for (const qid of qdrantIds) {
          try {
            const point = await getPoint(qid);
            if (point?.payload?.content_hash && !pgHashes.has(point.payload.content_hash)) {
              report.qdrant_orphans.count++;
              if (report.qdrant_orphans.ids.length < 20) {
                report.qdrant_orphans.ids.push({
                  id: qid,
                  type: point.payload.type,
                  content_preview: (point.payload.text || '').slice(0, 100),
                  source_agent: point.payload.source_agent,
                  created_at: point.payload.created_at,
                });
              }
            }
          } catch (e) { /* point fetch failed, skip */ }
          orphanCheckCount++;
          // Batch check — don't fetch every single point, sample first 500
          if (orphanCheckCount > 500) break;
        }
      }
    }

    // --- 2. Clean keyword index orphans ---
    if (isKeywordSearchAvailable() && isStoreAvailable()) {
      const store = _getStoreInstance();
      if (store?.pool) {
        // Find keyword entries marked active but pointing to inactive/missing Qdrant vectors
        const activeKeywords = await store.pool.query(
          'SELECT memory_id FROM memory_search WHERE active = true'
        );
        const keywordMemoryIds = activeKeywords.rows.map(r => r.memory_id);

        let orphanCount = 0;
        const orphanIds = [];
        // Check a batch of keyword entries against Qdrant
        for (const memId of keywordMemoryIds.slice(0, 600)) {
          try {
            const point = await getPoint(memId);
            if (!point || !point.payload || point.payload.active === false) {
              orphanCount++;
              orphanIds.push(memId);
            }
          } catch (e) {
            // Point doesn't exist in Qdrant — definite orphan
            orphanCount++;
            orphanIds.push(memId);
          }
        }

        report.keyword_orphans.count = orphanCount;

        if (!isDryRun && fixKeywordOrphans && orphanIds.length > 0) {
          // Deactivate orphaned keyword entries
          for (const id of orphanIds) {
            try {
              await store.pool.query(
                'UPDATE memory_search SET active = false WHERE memory_id = $1', [id]
              );
              report.keyword_orphans.cleaned++;
            } catch (e) { /* skip */ }
          }
        }
      }
    }

    // --- 3. Scan for garbage entities (single-mention, not proper nouns) ---
    if (isEntityStoreAvailable() && fixEntityGarbage) {
      const store = _getStoreInstance();
      if (store?.pool) {
        const garbageResult = await store.pool.query(`
          SELECT id, canonical_name, entity_type, mention_count FROM entities
          WHERE mention_count <= 1 AND (
            canonical_name ~ '^[a-z]'
            OR canonical_name ~ '\\d'
            OR array_length(string_to_array(canonical_name, ' '), 1) >= 4
            OR canonical_name = lower(canonical_name)
          )
          ORDER BY canonical_name
          LIMIT 100
        `);

        report.entity_garbage.count = garbageResult.rows.length;
        report.entity_garbage.samples = garbageResult.rows.slice(0, 15).map(r => ({
          id: r.id,
          name: r.canonical_name,
          type: r.entity_type,
          mentions: r.mention_count,
        }));

        if (!isDryRun) {
          for (const row of garbageResult.rows) {
            try {
              await store.pool.query('DELETE FROM entities WHERE id = $1', [row.id]);
              report.entity_garbage.cleaned++;
            } catch (e) { /* cascade failure, skip */ }
          }
        }
      }
    }

    // --- 4. Detect duplicate entities (same name, different case/type) ---
    if (isEntityStoreAvailable()) {
      const store = _getStoreInstance();
      if (store?.pool) {
        const dupeResult = await store.pool.query(`
          SELECT lower(canonical_name) as lname, count(*) as cnt,
                 array_agg(canonical_name || ' (' || entity_type || ', ' || mention_count || 'm)') as variants
          FROM entities
          GROUP BY lower(canonical_name)
          HAVING count(*) > 1
          ORDER BY count(*) DESC
          LIMIT 20
        `);

        report.entity_duplicates.count = dupeResult.rows.length;
        report.entity_duplicates.samples = dupeResult.rows.map(r => ({
          name: r.lname,
          count: parseInt(r.cnt),
          variants: r.variants,
        }));
      }
    }

    console.log(`[reconcile] ${isDryRun ? 'Dry run' : 'Applied'}: ${report.qdrant_orphans.count} Qdrant orphans, ${report.keyword_orphans.count} keyword orphans (${report.keyword_orphans.cleaned} cleaned), ${report.entity_garbage.count} garbage entities (${report.entity_garbage.cleaned} cleaned), ${report.entity_duplicates.count} duplicate groups`);

    res.json(report);
  } catch (err) {
    console.error('[reconcile]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /reconcile/status — Quick health check for data layer sync
 */
reconcileRouter.get('/status', async (req, res) => {
  try {
    const status = {
      stores: {
        qdrant: true,
        postgres: isStoreAvailable(),
        keyword: isKeywordSearchAvailable(),
        entities: isEntityStoreAvailable(),
      },
    };

    if (isStoreAvailable()) {
      const store = _getStoreInstance();
      if (store?.pool) {
        const [events, facts, statuses, keywords, entities] = await Promise.all([
          store.pool.query('SELECT COUNT(*) as count FROM events'),
          store.pool.query('SELECT COUNT(*) as count FROM facts'),
          store.pool.query('SELECT COUNT(*) as count FROM statuses'),
          store.pool.query('SELECT COUNT(*) as count FROM memory_search WHERE active = true').catch(() => ({ rows: [{ count: 0 }] })),
          store.pool.query('SELECT COUNT(*) as count FROM entities').catch(() => ({ rows: [{ count: 0 }] })),
        ]);

        status.postgres = {
          events: parseInt(events.rows[0].count),
          facts: parseInt(facts.rows[0].count),
          statuses: parseInt(statuses.rows[0].count),
          keyword_entries: parseInt(keywords.rows[0].count),
          entities: parseInt(entities.rows[0].count),
        };
      }
    }

    res.json(status);
  } catch (err) {
    console.error('[reconcile:status]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
