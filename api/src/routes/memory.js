import { Router } from 'express';
import crypto from 'crypto';
import { embed } from '../services/embedders/interface.js';
import {
  upsertPoint, searchPoints, updatePointPayload,
  findByPayload, computeEffectiveConfidence, getPoint,
} from '../services/qdrant.js';
import {
  createEvent, upsertFact, upsertStatus, listEvents, listFacts, listStatuses, isStoreAvailable,
  isEntityStoreAvailable, createEntity, findEntity, linkEntityToMemory,
} from '../services/stores/interface.js';
import { scrubCredentials, scrubObject } from '../services/scrub.js';
import { extractEntities, linkExtractedEntities } from '../services/entities.js';
import { validateMemoryInput, MAX_OBSERVED_BY } from '../middleware/validate.js';

export const memoryRouter = Router();

// POST /memory — Store a memory
memoryRouter.post('/', async (req, res) => {
  try {
    const { type, content, source_agent, client_id, category, importance, metadata } = req.body;

    // Validate all input fields
    const validationError = validateMemoryInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Enforce agent identity: if authenticated with an agent key, source_agent must match
    if (req.authenticatedAgent && source_agent !== req.authenticatedAgent) {
      return res.status(403).json({
        error: `Agent identity mismatch: authenticated as "${req.authenticatedAgent}" but source_agent is "${source_agent}"`,
      });
    }

    // Scrub credentials
    const cleanContent = scrubCredentials(content);

    // Generate content hash for dedup
    const contentHash = crypto.createHash('sha256').update(cleanContent).digest('hex').slice(0, 16);

    // --- Deduplication check ---
    const duplicates = await findByPayload('content_hash', contentHash, { active: true });
    if (duplicates.length > 0) {
      const existing = duplicates[0];
      const existingObservedBy = existing.payload.observed_by || [existing.payload.source_agent];

      // Same agent → true dedup (skip)
      if (existingObservedBy.includes(source_agent)) {
        return res.status(200).json({
          id: existing.id,
          type: existing.payload.type,
          content_hash: contentHash,
          deduplicated: true,
          observed_by: existingObservedBy,
          observation_count: existingObservedBy.length,
          message: 'Exact duplicate from same agent — returning existing memory',
          stored_in: { qdrant: true, structured_db: true },
        });
      }

      // Different agent → corroborate: record that another agent observed the same thing
      if (existingObservedBy.length >= MAX_OBSERVED_BY) {
        return res.status(200).json({
          id: existing.id,
          type: existing.payload.type,
          content_hash: contentHash,
          deduplicated: true,
          observed_by: existingObservedBy,
          observation_count: existingObservedBy.length,
          message: `Observer cap reached (${MAX_OBSERVED_BY}) — corroboration noted but not recorded`,
          stored_in: { qdrant: true, structured_db: true },
        });
      }
      const updatedObservedBy = [...existingObservedBy, source_agent];
      const now = new Date().toISOString();
      await updatePointPayload(existing.id, {
        observed_by: updatedObservedBy,
        observation_count: updatedObservedBy.length,
        last_observed_at: now,
      });

      return res.status(200).json({
        id: existing.id,
        type: existing.payload.type,
        content_hash: contentHash,
        corroborated: true,
        observed_by: updatedObservedBy,
        observation_count: updatedObservedBy.length,
        message: `Cross-agent corroboration recorded — now observed by ${updatedObservedBy.length} agents`,
        stored_in: { qdrant: true, structured_db: true },
      });
    }

    const now = new Date().toISOString();
    const pointId = crypto.randomUUID();

    // --- Supersedes logic for facts and statuses ---
    let supersedesId = null;
    let keyWarning = null;

    // Facts without keys can't be superseded — they pile up forever.
    // Log a warning so we can track and fix callers over time.
    if (type === 'fact' && !req.body.key) {
      keyWarning = 'Fact stored without key — cannot be superseded. Provide a key for long-term memory hygiene.';
      console.warn(`[memory:store] ${keyWarning} agent=${source_agent} content="${cleanContent.slice(0, 60)}..."`);
    }

    if (type === 'fact' && req.body.key) {
      // Find existing active fact with same key (targeted Qdrant query)
      const matches = await findByPayload('key', req.body.key, { active: true, type: 'fact' }, 1);
      if (matches.length > 0) {
        supersedesId = matches[0].id;
        await updatePointPayload(matches[0].id, {
          active: false,
          superseded_by: pointId,
          superseded_at: now,
        });
      }
    } else if (type === 'status' && req.body.subject) {
      // Find existing active status with same subject (targeted Qdrant query)
      const matches = await findByPayload('subject', req.body.subject, { active: true, type: 'status' }, 1);
      if (matches.length > 0) {
        supersedesId = matches[0].id;
        await updatePointPayload(matches[0].id, {
          active: false,
          superseded_by: pointId,
          superseded_at: now,
        });
      }
    }

    // Build payload
    const payload = {
      text: cleanContent,
      type,
      source_agent,
      observed_by: [source_agent],
      observation_count: 1,
      client_id: client_id || 'global',
      category: category || 'episodic',
      importance: importance || 'medium',
      content_hash: contentHash,
      created_at: now,
      last_accessed_at: now,
      access_count: 0,
      confidence: 1.0,
      active: true,
      consolidated: false,
      supersedes: supersedesId,
      superseded_by: null,
      ...(type === 'fact' && req.body.key ? { key: req.body.key } : {}),
      ...(type === 'status' && req.body.subject ? { subject: req.body.subject, status_value: req.body.status_value } : {}),
      ...(metadata ? { metadata: scrubObject(metadata) } : {}),
    };

    // Extract entities (fast path — regex + alias cache, no LLM)
    let extractedEntities = [];
    try {
      extractedEntities = extractEntities(cleanContent, client_id || 'global', source_agent);
      if (extractedEntities.length > 0) {
        payload.entities = extractedEntities.map(e => ({ name: e.name, type: e.type }));
      }
    } catch (e) {
      console.error('[memory:entities] Extraction failed (non-blocking):', e.message);
    }

    // Embed and store in Qdrant
    const vector = await embed(cleanContent);
    await upsertPoint(pointId, vector, payload);

    // Link entities in structured store (fire-and-forget — don't block response)
    if (isEntityStoreAvailable() && extractedEntities.length > 0) {
      Promise.resolve().then(async () => {
        try {
          await linkExtractedEntities(extractedEntities, pointId, { createEntity, findEntity, linkEntityToMemory });
        } catch (e) {
          console.error('[memory:entities] Linking failed:', e.message);
        }
      });
    }

    // Store in structured database (if configured)
    const storeData = {
      content: cleanContent,
      source_agent,
      client_id: client_id || 'global',
      category: category || 'episodic',
      importance: importance || 'medium',
      content_hash: contentHash,
      created_at: now,
    };

    let storeResult = null;
    if (isStoreAvailable()) {
      try {
        if (type === 'event' || type === 'decision') {
          storeData.type = type;
          storeResult = await createEvent(storeData);
        } else if (type === 'fact') {
          storeData.key = req.body.key || contentHash;
          storeData.value = cleanContent;
          storeResult = await upsertFact(storeData);
        } else if (type === 'status') {
          storeData.subject = req.body.subject || 'unknown';
          storeData.status = req.body.status_value || cleanContent;
          storeResult = await upsertStatus(storeData);
        }
      } catch (storeErr) {
        // Qdrant succeeded, structured store failed — log but don't fail the request
        console.error('[store] Write failed (Qdrant succeeded):', storeErr.message);
      }
    }

    res.status(201).json({
      id: pointId,
      type,
      content_hash: contentHash,
      deduplicated: false,
      supersedes: supersedesId,
      stored_in: {
        qdrant: true,
        structured_db: !!storeResult,
      },
      ...(keyWarning ? { warning: keyWarning } : {}),
    });
  } catch (err) {
    console.error('[memory:store] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /memory/search — Semantic search via Qdrant
memoryRouter.get('/search', async (req, res) => {
  try {
    const { q, type, source_agent, client_id, category, limit, include_superseded, entity, format } = req.query;
    const isCompact = format === 'compact';

    if (!q) {
      return res.status(400).json({ error: 'Missing required query parameter: q' });
    }

    const vector = await embed(q);

    const filter = {};
    if (type) filter.type = type;
    if (source_agent) filter.source_agent = source_agent;
    if (client_id) filter.client_id = client_id;
    if (category) filter.category = category;
    // By default, only return active memories (not superseded)
    if (include_superseded !== 'true') filter.active = true;

    // Entity filter — resolve alias to canonical name, then filter via Qdrant payload
    const nestedFilters = [];
    if (entity) {
      let entityName = entity;
      if (isEntityStoreAvailable()) {
        try {
          const found = await findEntity(entity);
          if (found) entityName = found.canonical_name;
        } catch (e) { /* use original name */ }
      }
      nestedFilters.push({ arrayField: 'entities', key: 'name', value: entityName });
    }

    const rawResults = await searchPoints(vector, filter, Math.min(parseInt(limit) || 10, 100), nestedFilters);

    // Apply confidence decay + access-weighted ranking
    // Memories that get used more are more valuable — self-curating brain
    const COMPACT_MAX = 200;
    const results = rawResults.map(r => {
      const effectiveConfidence = computeEffectiveConfidence(r.payload);
      const p = r.payload;

      // Access boost: log(access_count + 1) gives diminishing returns
      // 0 accesses = 1.0x, 1 = 1.3x, 5 = 1.8x, 20 = 2.3x, 100 = 2.7x
      const accessBoost = 1 + (0.3 * Math.log2((p.access_count || 0) + 1));
      const effectiveScore = +(r.score * effectiveConfidence * accessBoost).toFixed(4);

      if (isCompact) {
        const text = p.text || '';
        return {
          id: r.id,
          score: +r.score.toFixed(4),
          effective_score: effectiveScore,
          type: p.type,
          content: text.length > COMPACT_MAX ? text.slice(0, COMPACT_MAX) + '...' : text,
          source_agent: p.source_agent,
          client_id: p.client_id,
          importance: p.importance,
          created_at: p.created_at,
        };
      }

      return {
        id: r.id,
        score: r.score,
        confidence: effectiveConfidence,
        effective_score: effectiveScore,
        ...p,
      };
    });

    // Re-sort by effective_score (now includes access weight)
    results.sort((a, b) => b.effective_score - a.effective_score);

    // Async: increment access_count and update last_accessed_at for returned results
    const pointIds = results.map(r => r.id);
    if (pointIds.length > 0) {
      // Fire and forget — don't slow down the response
      Promise.resolve().then(async () => {
        try {
          const now = new Date().toISOString();
          for (const result of results) {
            await updatePointPayload(result.id, {
              access_count: (result.access_count || 0) + 1,
              last_accessed_at: now,
            });
          }
        } catch (e) {
          console.error('[memory:search] Access count update failed:', e.message);
        }
      });
    }

    res.json({
      query: q,
      count: results.length,
      results,
    });
  } catch (err) {
    console.error('[memory:search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /memory/query — Structured query via database
memoryRouter.get('/query', async (req, res) => {
  try {
    if (!isStoreAvailable()) {
      return res.status(400).json({
        error: 'Structured queries require a database backend. Set STRUCTURED_STORE in .env (sqlite, postgres, or baserow).',
      });
    }

    const { type, source_agent, category, client_id, since, key, subject } = req.query;

    let results;
    const filters = { source_agent, category, client_id };

    if (type === 'fact' || type === 'facts') {
      if (key) filters.key = key;
      results = await listFacts(filters);
    } else if (type === 'status' || type === 'statuses') {
      if (subject) filters.subject = subject;
      results = await listStatuses(filters);
    } else {
      // Default to events (includes decisions)
      if (since) filters.since = since;
      results = await listEvents(filters);
    }

    res.json({
      type: type || 'events',
      count: results.results?.length || 0,
      results: results.results || [],
    });
  } catch (err) {
    console.error('[memory:query] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /memory/:id — Soft-delete a memory (mark inactive)
memoryRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    // Verify the point exists
    let point;
    try {
      point = await getPoint(id);
    } catch (e) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    if (!point || !point.payload) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    // Enforce agent identity: agent-scoped keys can only delete their own memories
    if (req.authenticatedAgent && point.payload.source_agent !== req.authenticatedAgent) {
      return res.status(403).json({
        error: `Agent "${req.authenticatedAgent}" cannot delete memories from "${point.payload.source_agent}"`,
      });
    }

    if (point.payload.active === false) {
      return res.status(200).json({ id, already_inactive: true, message: 'Memory was already inactive' });
    }

    const now = new Date().toISOString();
    await updatePointPayload(id, {
      active: false,
      deleted_at: now,
      deleted_by: req.authenticatedAgent || 'admin',
      deletion_reason: reason || null,
    });

    console.log(`[memory:delete] Memory ${id} soft-deleted by ${req.authenticatedAgent || 'admin'}${reason ? ': ' + reason : ''}`);

    res.json({
      id,
      deleted: true,
      deleted_at: now,
      deleted_by: req.authenticatedAgent || 'admin',
    });
  } catch (err) {
    console.error('[memory:delete] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
