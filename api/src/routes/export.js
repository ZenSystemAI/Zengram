import { Router } from 'express';
import crypto from 'crypto';
import { scrollPoints, upsertPoint, findByPayload } from '../services/qdrant.js';
import { embed } from '../services/embedders/interface.js';
import { isStoreAvailable, createEvent, upsertFact, upsertStatus } from '../services/stores/interface.js';
import { buildDedupExtraFilter, normalizeImportRecord } from '../services/memory-write-utils.js';

export const exportRouter = Router();

// GET /export — Export all matching memories as JSON (no vectors)
exportRouter.get('/', async (req, res) => {
  try {
    const { client_id, type, since, active_only } = req.query;

    // Build Qdrant scroll filter
    const filter = {};
    if (client_id) filter.client_id = client_id;
    if (type) filter.type = type;
    if (since) filter.created_after = since;
    if (active_only !== 'false') filter.active = true;

    const allPoints = [];
    let offset = null;
    const PAGE_SIZE = 100;

    // Paginated scroll through all matching points
    do {
      const result = await scrollPoints(filter, PAGE_SIZE, offset);
      const points = result.points || [];

      for (const point of points) {
        const p = point.payload || {};
        allPoints.push({
          id: point.id,
          content: p.text || p.content || '',
          type: p.type,
          key: p.key || null,
          subject: p.subject || null,
          client_id: p.client_id || null,
          knowledge_category: p.knowledge_category || null,
          category: p.category || null,
          source_agent: p.source_agent || null,
          importance: p.importance || null,
          confidence: p.confidence || null,
          access_count: p.access_count || 0,
          active: p.active !== undefined ? p.active : true,
          superseded_by: p.superseded_by || null,
          entities: p.entities || [],
          created_at: p.created_at || null,
          last_accessed_at: p.last_accessed_at || null,
          content_hash: p.content_hash || null,
        });
      }

      offset = result.next_page_offset || null;
    } while (offset);

    res.json({
      count: allPoints.length,
      exported_at: new Date().toISOString(),
      filters: { client_id, type, since, active_only: active_only !== 'false' },
      data: allPoints,
    });
  } catch (err) {
    console.error('[export] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /export/import — Import memories with dedup and batching
exportRouter.post('/import', async (req, res) => {
  try {
    const { data } = req.body;

    if (!data || !Array.isArray(data)) {
      return res.status(400).json({ error: 'Request body must contain a "data" array of memory objects' });
    }

    if (data.length > 500) {
      return res.status(400).json({ error: `Import limited to 500 records per request (received ${data.length})` });
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    const BATCH_SIZE = 10;

    // Process in batches of 10 with 100ms delay between batches
    for (let i = 0; i < data.length; i += BATCH_SIZE) {
      const batch = data.slice(i, i + BATCH_SIZE);

      // Add delay between batches (not before the first one)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Process each record in the batch sequentially
      for (const record of batch) {
        try {
          const { normalized, contentHash, error } = normalizeImportRecord(record);
          if (error) {
            errors++;
            continue;
          }

          // Check for existing memory with same hash in the same tenant/type scope
          const existing = await findByPayload('content_hash', contentHash, buildDedupExtraFilter(normalized.client_id, normalized.type));
          if (existing.length > 0) {
            skipped++;
            continue;
          }

          // Embed and generate ID
          const vector = await embed(normalized.content, 'store');
          const pointId = normalized.id || crypto.randomUUID();
          const now = new Date().toISOString();

          // Build full payload
          const payload = {
            text: normalized.content,
            type: normalized.type,
            key: normalized.key || null,
            subject: normalized.subject || null,
            client_id: normalized.client_id,
            knowledge_category: normalized.knowledge_category,
            category: normalized.category,
            source_agent: normalized.source_agent,
            importance: normalized.importance,
            confidence: normalized.confidence !== undefined ? normalized.confidence : 1.0,
            access_count: normalized.access_count || 0,
            active: normalized.active !== undefined ? normalized.active : true,
            superseded_by: normalized.superseded_by || null,
            entities: normalized.entities || [],
            content_hash: contentHash,
            created_at: normalized.created_at || now,
            last_accessed_at: normalized.last_accessed_at || now,
            observed_by: normalized.observed_by || [normalized.source_agent],
            observation_count: normalized.observation_count || 1,
            consolidated: normalized.consolidated || false,
          };

          // Upsert to Qdrant
          await upsertPoint(pointId, vector, payload);

          // Write to structured store (matching memory.js patterns)
          if (isStoreAvailable()) {
            try {
              const storeData = {
                content: normalized.content,
                source_agent: payload.source_agent,
                client_id: payload.client_id,
                category: payload.category,
                importance: payload.importance,
                content_hash: contentHash,
                created_at: payload.created_at,
              };

              const type = payload.type;
              if (type === 'event' || type === 'decision') {
                storeData.type = type;
                await createEvent(storeData);
              } else if (type === 'fact') {
                storeData.key = normalized.key || contentHash;
                storeData.value = normalized.content;
                await upsertFact(storeData);
              } else if (type === 'status') {
                storeData.subject = normalized.subject || 'unknown';
                storeData.status = normalized.status_value || normalized.content;
                await upsertStatus(storeData);
              }
            } catch (storeErr) {
              // Qdrant succeeded, structured store failed — log but count as imported
              console.error('[import] Structured store write failed:', storeErr.message);
            }
          }

          imported++;
        } catch (recordErr) {
          console.error('[import] Record error:', recordErr.message);
          errors++;
        }
      }
    }

    res.json({ imported, skipped, errors });
  } catch (err) {
    console.error('[import] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
