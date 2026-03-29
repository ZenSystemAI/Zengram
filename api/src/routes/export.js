import { Router } from 'express';
import crypto from 'crypto';
import { scrollPoints, upsertPoint, findByPayload } from '../services/qdrant.js';
import { embed } from '../services/embedders/interface.js';
import {
  isStoreAvailable, createEvent, upsertFact, upsertStatus,
  isEntityStoreAvailable, createEntity, findEntity, linkEntityToMemory, createRelationship,
} from '../services/stores/interface.js';
import { scrubCredentials } from '../services/scrub.js';
import { validateMemoryInput } from '../middleware/validate.js';
import { extractEntities, linkExtractedEntities } from '../services/entities.js';
import { isKeywordSearchAvailable, indexMemory } from '../services/keyword-search.js';
import { dispatchNotification } from '../services/notifications.js';

export const exportRouter = Router();

// GET /export — Export all matching memories as JSON (no vectors)
exportRouter.get('/', async (req, res) => {
  try {
    const { client_id, type, since, active_only } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 1000, 1), 5000);
    const userOffset = Math.max(parseInt(req.query.offset) || 0, 0);

    // Build Qdrant scroll filter
    const filter = {};
    if (client_id) filter.client_id = client_id;
    if (type) filter.type = type;
    if (since) filter.created_after = since;
    if (active_only !== 'false') filter.active = true;

    const memories = [];
    let scrollOffset = null;
    let skipped = 0;
    let total = 0;
    const PAGE_SIZE = 100;

    // Paginated scroll through matching points, respecting limit+offset
    do {
      const result = await scrollPoints(filter, PAGE_SIZE, scrollOffset);
      const points = result.points || [];

      for (const point of points) {
        total++;
        if (skipped < userOffset) {
          skipped++;
          continue;
        }
        if (memories.length >= limit) continue;

        const p = point.payload || {};
        memories.push({
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

      scrollOffset = result.next_page_offset || null;
    } while (scrollOffset);

    res.json({
      memories,
      total,
      limit,
      offset: userOffset,
      has_more: userOffset + memories.length < total,
      exported_at: new Date().toISOString(),
      filters: { client_id, type, since, active_only: active_only !== 'false' },
    });
  } catch (err) {
    console.error('[export]', err.message);
    res.status(500).json({ error: 'Internal server error' });
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
          const rawContent = record.content || record.text || '';
          if (!rawContent) {
            errors++;
            continue;
          }

          // Validate input (same rules as POST /memory)
          const validationError = validateMemoryInput({
            type: record.type || 'event',
            content: rawContent,
            source_agent: record.source_agent || 'import',
            importance: record.importance,
            client_id: record.client_id,
          });
          if (validationError) {
            errors++;
            continue;
          }

          // Scrub credentials (same as POST /memory)
          const content = scrubCredentials(rawContent);

          // Compute content hash from scrubbed content
          const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

          // Check for existing memory with same content hash, scoped by tenant + type
          const existing = await findByPayload('content_hash', contentHash, {
            active: true,
            client_id: record.client_id || 'global',
            type: record.type || 'event',
          });
          if (existing.length > 0) {
            skipped++;
            continue;
          }

          // Embed and generate ID
          const vector = await embed(content, 'store');
          const pointId = record.id || crypto.randomUUID();
          const now = new Date().toISOString();

          // Build full payload
          const payload = {
            text: content,
            type: record.type || 'event',
            key: record.key || null,
            subject: record.subject || null,
            client_id: record.client_id || 'global',
            knowledge_category: record.knowledge_category || null,
            category: record.category || 'episodic',
            source_agent: record.source_agent || 'import',
            importance: record.importance || 'medium',
            confidence: record.confidence !== undefined ? record.confidence : 1.0,
            access_count: record.access_count || 0,
            active: record.active !== undefined ? record.active : true,
            superseded_by: record.superseded_by || null,
            entities: record.entities || [],
            content_hash: contentHash,
            created_at: record.created_at || now,
            last_accessed_at: record.last_accessed_at || now,
            observed_by: record.observed_by || [record.source_agent || 'import'],
            observation_count: record.observation_count || 1,
            consolidated: record.consolidated || false,
          };

          // Upsert to Qdrant
          await upsertPoint(pointId, vector, payload);

          // Keyword index (fire-and-forget)
          if (isKeywordSearchAvailable()) {
            indexMemory(pointId, content, {
              client_id: payload.client_id,
              source_agent: payload.source_agent,
              type: payload.type,
            }).catch(e => console.error('[import:keyword-index]', e.message));
          }

          // Entity extraction + linking (fire-and-forget)
          try {
            const extractedEntities = extractEntities(content, payload.client_id, payload.source_agent);
            if (extractedEntities.length > 0) {
              payload.entities = extractedEntities.map(e => ({ name: e.name, type: e.type }));
              if (isEntityStoreAvailable()) {
                linkExtractedEntities(extractedEntities, pointId, { createEntity, findEntity, linkEntityToMemory, createRelationship })
                  .catch(e => console.error('[import:entities]', e.message));
              }
            }
          } catch (e) { /* non-blocking */ }

          // Notification (fire-and-forget)
          dispatchNotification('memory_stored', { id: pointId, ...payload });

          // Write to structured store (matching memory.js patterns)
          if (isStoreAvailable()) {
            try {
              const storeData = {
                content,
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
                storeData.key = record.key || contentHash;
                storeData.value = content;
                await upsertFact(storeData);
              } else if (type === 'status') {
                storeData.subject = record.subject || 'unknown';
                storeData.status = record.status_value || content;
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
    console.error('[import]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
