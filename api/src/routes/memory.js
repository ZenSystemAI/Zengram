import { Router } from 'express';
import crypto from 'crypto';
import { embed } from '../services/embedders/interface.js';
import {
  upsertPoint, searchPoints, updatePointPayload,
  findByPayload, computeEffectiveConfidence, getPoint, getPoints,
} from '../services/qdrant.js';
import {
  createEvent, upsertFact, upsertStatus, listEvents, listFacts, listStatuses, isStoreAvailable,
  isEntityStoreAvailable, createEntity, findEntity, linkEntityToMemory, createRelationship,
} from '../services/stores/interface.js';
import { scrubCredentials, scrubObject } from '../services/scrub.js';
import { extractEntities, linkExtractedEntities } from '../services/entities.js';
import { validateMemoryInput, MAX_OBSERVED_BY } from '../middleware/validate.js';
import { dispatchNotification } from '../services/notifications.js';
import { isKeywordSearchAvailable, indexMemory, deactivateMemory, keywordSearch } from '../services/keyword-search.js';
import { isGraphSearchAvailable, graphSearch } from '../services/graph-search.js';
import { reciprocalRankFusion } from '../services/rrf.js';

const MULTI_PATH_SEARCH = process.env.MULTI_PATH_SEARCH !== 'false'; // default: true
import { getClientResolver } from '../services/client-resolver.js';

export const memoryRouter = Router();

// POST /memory — Store a memory
memoryRouter.post('/', async (req, res) => {
  try {
    let { type, content, source_agent, client_id, category, importance, knowledge_category, metadata } = req.body;

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

    // Auto-resolve client_id from content if not provided or is 'global'
    if (!client_id || client_id === 'global') {
      const resolver = getClientResolver();
      const resolved = resolver.resolve(content);
      if (resolved && !Array.isArray(resolved)) {
        client_id = resolved;
      }
    }

    // Scrub credentials
    const cleanContent = scrubCredentials(content);

    // Generate content hash for dedup
    const contentHash = crypto.createHash('sha256').update(cleanContent).digest('hex').slice(0, 16);

    // --- Deduplication check ---
    const duplicates = await findByPayload('content_hash', contentHash, { active: true, client_id: client_id || 'global', type });
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
        deactivateMemory(matches[0].id).catch(() => {});
        dispatchNotification('memory_superseded', { id: matches[0].id, ...matches[0].payload });
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
        deactivateMemory(matches[0].id).catch(() => {});
        dispatchNotification('memory_superseded', { id: matches[0].id, ...matches[0].payload });
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
      knowledge_category: knowledge_category || 'general',
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
    const vector = await embed(cleanContent, 'store');
    await upsertPoint(pointId, vector, payload);

    // Index in keyword search (fire-and-forget)
    if (isKeywordSearchAvailable()) {
      indexMemory(pointId, cleanContent, {
        client_id: client_id || 'global',
        source_agent,
        type,
      }).catch(e => console.error('[memory:keyword-index]', e.message));
    }

    // Dispatch webhook notification for new memory
    dispatchNotification('memory_stored', { id: pointId, ...payload });

    // Link entities in structured store (fire-and-forget — don't block response)
    if (isEntityStoreAvailable() && extractedEntities.length > 0) {
      Promise.resolve().then(async () => {
        try {
          await linkExtractedEntities(extractedEntities, pointId, { createEntity, findEntity, linkEntityToMemory, createRelationship });
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
      knowledge_category: knowledge_category || 'general',
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
    console.error('[memory:store]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /memory/search — Multi-path retrieval with RRF fusion
// Paths: vector (semantic), keyword (BM25), graph (entity BFS)
memoryRouter.get('/search', async (req, res) => {
  try {
    const { q, type, source_agent, client_id, category, limit, include_superseded, entity, format } = req.query;
    const isCompact = format === 'compact';
    const isFull = format === 'full';
    const maxResults = Math.min(parseInt(limit) || 10, 100);

    if (!q) {
      return res.status(400).json({ error: 'Missing required query parameter: q' });
    }

    const filter = {};
    if (type) filter.type = type;
    if (source_agent) filter.source_agent = source_agent;
    if (client_id) filter.client_id = client_id;
    if (category) filter.category = category;
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

    // --- Multi-path retrieval ---
    const useMultiPath = MULTI_PATH_SEARCH && !entity; // entity filter is Qdrant-only
    const fetchLimit = useMultiPath ? Math.min(maxResults * 2, 50) : maxResults;

    // Always run vector search
    const vectorPromise = embed(q, 'search').then(vector =>
      searchPoints(vector, filter, fetchLimit, nestedFilters)
    );

    // Run keyword + graph in parallel (only if multi-path enabled)
    const keywordPromise = (useMultiPath && isKeywordSearchAvailable())
      ? keywordSearch(q, filter, fetchLimit).catch(e => {
          console.error('[memory:keyword-search]', e.message);
          return [];
        })
      : Promise.resolve([]);

    const graphPromise = (useMultiPath && isGraphSearchAvailable())
      ? graphSearch(q, filter, Math.min(maxResults, 20)).catch(e => {
          console.error('[memory:graph-search]', e.message);
          return [];
        })
      : Promise.resolve([]);

    const [vectorResults, keywordResults, graphResults] = await Promise.all([
      vectorPromise, keywordPromise, graphPromise,
    ]);

    // --- Build result set ---
    let finalResults;
    const retrievalSources = {};

    if (useMultiPath && (keywordResults.length > 0 || graphResults.length > 0)) {
      // Build ranked lists for RRF
      const rankedLists = [
        vectorResults.map(r => ({ id: r.id, source: 'vector' })),
      ];
      if (keywordResults.length > 0) {
        rankedLists.push(keywordResults.map(r => ({ id: r.memory_id, source: 'keyword' })));
      }
      if (graphResults.length > 0) {
        rankedLists.push(graphResults.map(r => ({ id: r.memory_id, source: 'graph' })));
      }

      const fused = reciprocalRankFusion(rankedLists);
      const topFused = fused.slice(0, maxResults);

      // Track which sources contributed to each result
      for (const f of topFused) {
        retrievalSources[f.id] = f.sources;
      }

      // Build payload map from vector results (already have full payloads)
      const payloadMap = new Map();
      for (const r of vectorResults) {
        payloadMap.set(r.id, { id: r.id, score: r.score, payload: r.payload });
      }

      // Fetch payloads for keyword/graph hits not in vector results
      const missingIds = topFused.map(f => f.id).filter(id => !payloadMap.has(id));
      if (missingIds.length > 0) {
        try {
          const fetched = await getPoints(missingIds);
          for (const pt of fetched) {
            payloadMap.set(pt.id, { id: pt.id, score: 0, payload: pt.payload });
          }
        } catch (e) {
          console.error('[memory:search] Batch fetch failed:', e.message);
        }
      }

      // Assemble results in RRF order
      finalResults = topFused
        .map(f => payloadMap.get(f.id))
        .filter(Boolean);
    } else {
      // Single-path: vector only
      finalResults = vectorResults.slice(0, maxResults);
    }

    // Apply confidence decay + access-weighted ranking
    const COMPACT_MAX = 200;
    const results = finalResults.map(r => {
      const effectiveConfidence = computeEffectiveConfidence(r.payload);
      const p = r.payload;
      const accessBoost = 1 + (0.3 * Math.log2((p.access_count || 0) + 1));
      const effectiveScore = +(((r.score || 0.5) * effectiveConfidence * accessBoost)).toFixed(4);

      if (isCompact) {
        const text = p.text || '';
        return {
          id: r.id,
          score: +(r.score || 0).toFixed(4),
          effective_score: effectiveScore,
          type: p.type,
          content: text.length > COMPACT_MAX ? text.slice(0, COMPACT_MAX) + '...' : text,
          source_agent: p.source_agent,
          client_id: p.client_id,
          importance: p.importance,
          created_at: p.created_at,
        };
      }

      const base = {
        id: r.id,
        score: r.score || 0,
        confidence: effectiveConfidence,
        effective_score: effectiveScore,
        ...p,
      };

      // In full format, show which retrieval paths contributed
      if (isFull && retrievalSources[r.id]) {
        base.retrieval_sources = retrievalSources[r.id];
      }

      return base;
    });

    // Re-sort by effective_score
    results.sort((a, b) => b.effective_score - a.effective_score);

    // Async: increment access_count and update last_accessed_at for returned results (parallel, fire-and-forget)
    const pointIds = results.map(r => r.id);
    if (pointIds.length > 0) {
      const now = new Date().toISOString();
      Promise.all(
        results.map(result =>
          updatePointPayload(result.id, {
            access_count: (result.access_count || 0) + 1,
            last_accessed_at: now,
          })
        )
      ).catch(e => {
        console.error('[memory:search] Access count update failed:', e.message);
      });
    }

    const response = {
      query: q,
      count: results.length,
      results,
    };

    // In full format, add retrieval metadata
    if (isFull && useMultiPath) {
      response.retrieval = {
        multi_path: true,
        paths: {
          vector: vectorResults.length,
          keyword: keywordResults.length,
          graph: graphResults.length,
        },
      };
    }

    res.json(response);
  } catch (err) {
    console.error('[memory:search]', err.message);
    res.status(500).json({ error: 'Internal server error' });
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
    console.error('[memory:query]', err.message);
    res.status(500).json({ error: 'Internal server error' });
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

    deactivateMemory(id).catch(() => {});
    dispatchNotification('memory_deleted', { id, ...point.payload });

    console.log(`[memory:delete] Memory ${id} soft-deleted by ${req.authenticatedAgent || 'admin'}${reason ? ': ' + reason : ''}`);

    res.json({
      id,
      deleted: true,
      deleted_at: now,
      deleted_by: req.authenticatedAgent || 'admin',
    });
  } catch (err) {
    console.error('[memory:delete]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
