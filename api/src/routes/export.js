import { Router } from 'express';
import crypto from 'crypto';
import { scrollPoints, upsertPoint, findByPayload } from '../services/pgvector.js';
import { embed } from '../services/embedders/interface.js';
import {
  isStoreAvailable, createEvent, upsertFact, upsertStatus,
  isEntityStoreAvailable, createEntity, findEntity, linkEntityToMemory, createRelationship,
} from '../services/stores/interface.js';
import { scrubCredentials, scrubObject, contentHash as hashContent } from '../services/scrub.js';
import { validateMemoryInput, validateNoToolCallControlMarkup } from '../middleware/validate.js';
import { requestHasOperatorApproval, isInvalidIsoTimestampParam, isInvalidStringParam } from '../services/request-utils.js';
import { extractEntities, linkExtractedEntities } from '../services/entities.js';
import { isKeywordSearchAvailable, indexMemory } from '../services/keyword-search.js';
import { logError, errorSummary } from '../lib/log.js';

export const exportRouter = Router();

// GET /export — Export all matching memories as JSON (no vectors)
exportRouter.get('/', async (req, res) => {
  try {
    const { client_id, type, since, active_only } = req.query;
    if (isInvalidStringParam(client_id)) return res.status(400).json({ error: 'client_id must be a string' });
    if (isInvalidStringParam(since)) return res.status(400).json({ error: 'since must be a string' });
    for (const [name, value] of Object.entries({ client_id, type, since, active_only, limit: req.query.limit, offset: req.query.offset })) {
      const error = validateNoToolCallControlMarkup(value, name);
      if (error) return res.status(400).json({ error });
    }
    if (isInvalidIsoTimestampParam(since)) {
      return res.status(400).json({
        error: 'Invalid since parameter — must be an ISO 8601 timestamp',
        example: '/export?since=2026-03-09T00:00:00Z',
      });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 1000, 1), 5000);
    const userOffset = Math.max(parseInt(req.query.offset) || 0, 0);

    // Build vector-store scroll filter
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
          supersedes: p.supersedes || null,
          superseded_by: p.superseded_by || null,
          superseded_at: p.superseded_at || null,
          deleted_at: p.deleted_at || null,
          deletion_reason: p.deletion_reason || null,
          entities: p.entities || [],
          created_at: p.created_at || null,
          last_accessed_at: p.last_accessed_at || null,
          valid_from: p.valid_from || null,
          valid_to: p.valid_to || null,
          observed_by: p.observed_by || [],
          observation_count: p.observation_count || 0,
          consolidated: p.consolidated || false,
          metadata: p.metadata || null,
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
    logError(req, '[export]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /export/import — Import memories with dedup and batching
exportRouter.post('/import', async (req, res) => {
  try {
    // Import restores/overwrites live memories — guard against an agent
    // triggering a destructive restore unprompted. Requires operator_approved=true
    // in the body or query.
    if (!requestHasOperatorApproval(req)) {
      return res.status(403).json({
        error: 'operator_approved=true is required for import restores',
      });
    }

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

      for (const record of batch) {
        try {
          const rawContent = record.content || record.text || '';
          if (!rawContent) {
            errors++;
            continue;
          }

          // Validate with the full POST /memory rule set (previously only a
          // 5-field subset ran, letting malformed entities/confidence/
          // observed_by slip through into the payload).
          const validationError = validateMemoryInput({
            type: record.type || 'event',
            content: rawContent,
            source_agent: record.source_agent || 'import',
            importance: record.importance,
            client_id: record.client_id,
            knowledge_category: record.knowledge_category,
            metadata: record.metadata,
            key: record.key,
            subject: record.subject,
            status_value: record.status_value,
            valid_from: record.valid_from,
            valid_to: record.valid_to,
          }, { allowToolCallControlMarkup: true });
          if (validationError) {
            errors++;
            continue;
          }

          // Shape guards for fields exported-format passes through untyped.
          if (record.entities !== undefined && !Array.isArray(record.entities)) { errors++; continue; }
          if (record.observed_by !== undefined && !Array.isArray(record.observed_by)) { errors++; continue; }
          if (record.confidence !== undefined && typeof record.confidence !== 'number') { errors++; continue; }
          if (record.access_count !== undefined && typeof record.access_count !== 'number') { errors++; continue; }

          const content = scrubCredentials(rawContent);

          const contentHash = hashContent(content);

          const existing = await findByPayload('content_hash', contentHash, {
            active: true,
            client_id: record.client_id || 'global',
            type: record.type || 'event',
          });
          if (existing.length > 0) {
            skipped++;
            continue;
          }

          const vector = await embed(content, 'store');
          const pointId = record.id || crypto.randomUUID();
          const now = new Date().toISOString();

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
            supersedes: record.supersedes || null,
            superseded_by: record.superseded_by || null,
            superseded_at: record.superseded_at || null,
            deleted_at: record.deleted_at || null,
            deletion_reason: record.deletion_reason || null,
            entities: record.entities || [],
            content_hash: contentHash,
            created_at: record.created_at || now,
            last_accessed_at: record.last_accessed_at || now,
            ...((record.type === 'fact' || record.type === 'status') ? {
              valid_from: record.valid_from || record.created_at || now,
              valid_to: record.valid_to || null,
            } : {}),
            ...(record.metadata ? { metadata: scrubObject(record.metadata) } : {}),
            observed_by: record.observed_by || [record.source_agent || 'import'],
            observation_count: record.observation_count || 1,
            consolidated: record.consolidated || false,
          };

          // Upsert to the vector store
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
              // the vector store succeeded, structured store failed — log but count as imported
              console.error('[import] Structured store write failed:', storeErr.message);
            }
          }

          imported++;
        } catch (recordErr) {
          console.error('[import] Record error: %s', errorSummary(recordErr));
          errors++;
        }
      }
    }

    res.json({ imported, skipped, errors });
  } catch (err) {
    logError(req, '[import]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
