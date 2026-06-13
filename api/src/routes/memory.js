import { Router } from 'express';
import crypto from 'crypto';
import { embed } from '../services/embedders/interface.js';
import {
  upsertPoint, searchPoints, updatePointPayload,
  findByPayload, computeEffectiveConfidence, getPoint, getPoints,
  supersedeAndInsert, bumpAccessCounts,
} from '../services/pgvector.js';
import {
  createEvent, upsertFact, upsertStatus, listEvents, listFacts, listStatuses, isStoreAvailable,
  isEntityStoreAvailable, createEntity, findEntity, linkEntityToMemory, createRelationship,
} from '../services/stores/interface.js';
import { scrubCredentials, scrubObject, contentHash as hashContent } from '../services/scrub.js';
import { extractEntities, linkExtractedEntities } from '../services/entities.js';
import { validateMemoryInput, validateContent, validateImportance, validateMetadata, VALID_KNOWLEDGE_CATEGORIES } from '../middleware/validate.js';
import { isKeywordSearchAvailable, indexMemory, deactivateMemory, keywordSearch } from '../services/keyword-search.js';
import { reciprocalRankFusion } from '../services/rrf.js';
import { scoreRelevance, relevancePayloadFields } from '../services/relevance-scorer.js';
import { resolveTemporalQuery, temporalProximityBoost } from '../services/temporal-resolver.js';
import { analyzeQuery, expandQuery, extractSearchTerms } from '../services/query-expander.js';
import { truthyParam, falseyParam } from '../services/request-utils.js';
import { logError } from '../lib/log.js';

const MULTI_PATH_SEARCH = process.env.MULTI_PATH_SEARCH !== 'false'; // default: true

// Canonical identity — every write is attributed to "claude-code" regardless
// of what source_agent the caller sends.
const CANONICAL_AGENT = 'claude-code';

// Shared 404-or-point helper for routes that operate on an existing memory.
// Returns the point on success, null after sending the 404.
async function requirePoint(id, res) {
  let point;
  try { point = await getPoint(id); }
  catch { res.status(404).json({ error: 'Memory not found' }); return null; }
  if (!point || !point.payload) {
    res.status(404).json({ error: 'Memory not found' });
    return null;
  }
  return point;
}

export const memoryRouter = Router();

// POST /memory — Store a memory
memoryRouter.post('/', async (req, res) => {
  try {
    let { type, content, source_agent, client_id, category, importance, knowledge_category, metadata, valid_from, valid_to } = req.body;

    // Validate all input fields
    const validationError = validateMemoryInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    source_agent = CANONICAL_AGENT;
    if (!client_id) client_id = 'global';

    const cleanContent = scrubCredentials(content);
    const contentHash = hashContent(cleanContent);

    // --- Deduplication check ---
    // With canonical-identity coercion, every new write has the same
    // source_agent, so cross-agent corroboration cannot fire. Duplicate hit
    // returns the existing memory unchanged.
    const duplicates = await findByPayload('content_hash', contentHash, { active: true, client_id: client_id || 'global', type });
    if (duplicates.length > 0) {
      const existing = duplicates[0];
      return res.status(200).json({
        id: existing.id,
        type: existing.payload.type,
        content_hash: contentHash,
        deduplicated: true,
        message: 'Exact duplicate — returning existing memory',
        stored_in: { vector: true, structured_db: true },
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

    // For keyed facts/statuses, the deactivate-prior + insert-new pair is performed
    // atomically below via supersedeAndInsert (under a per-key advisory lock). Here we
    // only do a best-effort read to populate payload.supersedes; the helper re-finds
    // the prior row under the lock and returns the authoritative supersededId.
    const isKeyedFact = type === 'fact' && req.body.key;
    const isKeyedStatus = type === 'status' && req.body.subject;
    if (isKeyedFact) {
      const matches = await findByPayload('key', req.body.key, { active: true, type: 'fact' }, 1);
      if (matches.length > 0) supersedesId = matches[0].id;
    } else if (isKeyedStatus) {
      const matches = await findByPayload('subject', req.body.subject, { active: true, type: 'status' }, 1);
      if (matches.length > 0) supersedesId = matches[0].id;
    }

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
      // Temporal validity (facts and statuses only)
      ...((type === 'fact' || type === 'status') ? {
        valid_from: valid_from || now,
        valid_to: valid_to || null,
      } : {}),
    };

    // Compress-at-ingestion for long event memories. Store raw text in
    // payload.text for semantic-rich embedding; store a trimmed version in
    // payload.text_compressed for compact/index formats at read time.
    if (type === 'event' && cleanContent.length > 400) {
      const lines = cleanContent.split('\n');
      const title = lines.find(l => l.trim() && !l.trim().startsWith('#')) || lines[0] || '';
      const heading = lines.find(l => l.trim().startsWith('## ') || l.trim().startsWith('### ')) || '';
      const bullets = lines.filter(l => /^\s*[-*]\s/.test(l)).slice(0, 7);
      if (bullets.length >= 2) {
        payload.text_compressed = [heading, ...bullets].filter(Boolean).join('\n').trim();
      } else {
        payload.text_compressed = cleanContent.slice(0, 300) + '...';
      }
    }

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

    // Embed full text (not compressed) — full content has more semantic signal
    const vector = await embed(cleanContent, 'store');

    // Relevance scoring (uses the already-computed vector — no extra embed call)
    let relevanceResult = null;
    try {
      relevanceResult = await scoreRelevance({
        content: cleanContent,
        type,
        importance: importance || 'medium',
        source_agent,
        entities: extractedEntities,
        vector,
        client_id: client_id || 'global',
      });
      Object.assign(payload, relevancePayloadFields(relevanceResult));
    } catch (e) {
      console.error('[memory:relevance] Scoring failed (non-blocking):', e.message);
    }

    // Store in the vector store. Keyed facts/statuses go through the atomic
    // supersede+insert (one transaction, advisory-locked, exactly one insert);
    // everything else (events, decisions, keyless facts) uses upsertPoint. The
    // new point is inserted EXACTLY ONCE per request — never via both paths.
    if (isKeyedFact || isKeyedStatus) {
      const keyField = isKeyedFact ? 'key' : 'subject';
      const keyValue = isKeyedFact ? req.body.key : req.body.subject;
      const { supersededId } = await supersedeAndInsert(
        keyField, keyValue, pointId, vector, payload,
        { superseded_by: pointId, superseded_at: now, valid_to: now },
        undefined
      );
      supersedesId = supersededId;
      // Keyword-index deactivation of the superseded row (fire-and-forget, after commit).
      if (supersededId) {
        deactivateMemory(supersededId).catch(e => console.error('[memory:keyword-deactivate]', e.message));
      }
    } else {
      await upsertPoint(pointId, vector, payload);
    }

    // Index in keyword search (fire-and-forget)
    if (isKeywordSearchAvailable()) {
      indexMemory(pointId, cleanContent, {
        client_id: client_id || 'global',
        source_agent,
        type,
      }).catch(e => console.error('[memory:keyword-index]', e.message));
    }

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
        // the vector store succeeded, structured store failed — log but don't fail the request
        console.error('[store] Write failed (vector store succeeded):', storeErr.message);
      }
    }

    res.status(201).json({
      id: pointId,
      type,
      content_hash: contentHash,
      deduplicated: false,
      supersedes: supersedesId,
      stored_in: {
        vector: true,
        structured_db: !!storeResult,
      },
      ...(relevanceResult ? { relevance: { score: relevanceResult.score, classification: relevanceResult.classification, signals: relevanceResult.signals } } : {}),
      ...(keyWarning ? { warning: keyWarning } : {}),
    });
  } catch (err) {
    logError(req, '[memory:store]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /memory/search — Multi-path retrieval with RRF fusion
// Paths: vector (semantic) + keyword (BM25). Graph BFS path retired in v4.
memoryRouter.get('/search', async (req, res) => {
  try {
    const { q, type, source_agent, client_id, category, limit, include_superseded, entity, format, at_time, reference_date, date_from, date_to, knowledge_category: kc, read_only, track_access } = req.query;
    const isCompact = format === 'compact';
    const isIndex = format === 'index';
    const isFull = format === 'full';
    const maxResults = Math.min(parseInt(limit) || 10, 100);

    // Read-only / background sweeps (reflection, eval harness, consolidation
    // candidate-gathering) can opt out of access-count bumping so automated
    // reads don't pollute the recency/frequency signals that feed relevance.
    const trackAccess = !truthyParam(read_only) && !falseyParam(track_access);

    if (!q) {
      return res.status(400).json({ error: 'Missing required query parameter: q' });
    }

    // --- Query expansion / domain inference ---
    const queryAnalysis = analyzeQuery(q);
    let searchQuery = q;
    if (queryAnalysis.isVague && queryAnalysis.expansions) {
      searchQuery = expandQuery(q, queryAnalysis.expansions);
    }

    // --- Temporal date-range filtering ---
    const temporalResult = resolveTemporalQuery(q, reference_date || at_time);

    const filter = {};
    if (type) filter.type = type;
    if (source_agent) filter.source_agent = source_agent;
    if (client_id) filter.client_id = client_id;
    if (category) filter.category = category;
    if (kc) filter.knowledge_category = kc;
    if (include_superseded !== 'true') filter.active = true;

    // Entity filter — resolve alias to canonical name, then filter via payload.
    const nestedFilters = [];
    if (entity) {
      let entityName = entity;
      if (isEntityStoreAvailable()) {
        const found = await findEntity(entity);
        if (found) entityName = found.canonical_name;
      }
      nestedFilters.push({ arrayField: 'entities', key: 'name', value: entityName });
    }

    // Temporal validity filter — "what was true at time X?"
    const rangeFilters = [];
    if (at_time) {
      rangeFilters.push({ key: 'valid_from', range: { lte: at_time } });
    }

    // Date-range filter from temporal resolution or explicit params
    const effectiveDateFrom = date_from || temporalResult.dateFrom;
    const effectiveDateTo = date_to || temporalResult.dateTo;
    if (effectiveDateFrom) {
      rangeFilters.push({ key: 'created_at', range: { gte: effectiveDateFrom } });
    }
    if (effectiveDateTo) {
      rangeFilters.push({ key: 'created_at', range: { lte: effectiveDateTo } });
    }

    // --- Multi-path retrieval ---
    const useMultiPath = MULTI_PATH_SEARCH && !entity; // entity filter is vector-store-only
    const fetchLimit = useMultiPath ? Math.min(maxResults * 2, 50) : maxResults;

    // Always run vector search (use expanded query for better coverage)
    const vectorPromise = embed(searchQuery, 'search').then(vector =>
      searchPoints(vector, filter, fetchLimit, nestedFilters, rangeFilters)
    );

    // Run keyword in parallel with vector (only if multi-path enabled)
    const keywordPromise = (useMultiPath && isKeywordSearchAvailable())
      ? keywordSearch(q, filter, fetchLimit).catch(e => {
          console.error('[memory:keyword-search]', e.message);
          return [];
        })
      : Promise.resolve([]);

    const [vectorResults, keywordResults] = await Promise.all([
      vectorPromise, keywordPromise,
    ]);

    // --- Build result set ---
    let finalResults;
    const retrievalSources = {};

    if (useMultiPath && keywordResults.length > 0) {
      // Build ranked lists for RRF (vector + keyword)
      const rankedLists = [
        vectorResults.map(r => ({ id: r.id, source: 'vector' })),
      ];
      if (keywordResults.length > 0) {
        rankedLists.push(keywordResults.map(r => ({ id: r.memory_id, source: 'keyword' })));
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

      // Fetch payloads for keyword hits not in vector results
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

    // Post-filter for temporal validity (at_time) — applies to ALL search paths
    // Vector search already filters via pgvector range query, but keyword results bypass it
    if (at_time) {
      finalResults = finalResults.filter(r => {
        const p = r.payload;
        if (p.valid_from && p.valid_from > at_time) return false; // not yet valid
        if (p.valid_to && p.valid_to <= at_time) return false;    // already expired
        return true;
      });
    }

    // Apply confidence decay + access-weighted ranking + temporal boost + importance weighting
    const COMPACT_MAX = 200;
    const IMPORTANCE_WEIGHTS = { critical: 1.0, high: 0.85, medium: 0.7, low: 0.5 };
    const refDateForBoost = reference_date || at_time || null;
    const results = finalResults.map(r => {
      const effectiveConfidence = computeEffectiveConfidence(r.payload);
      const p = r.payload;
      const accessBoost = 1 + (0.3 * Math.log2((p.access_count || 0) + 1));
      // Temporal proximity boost — memories closer to reference date score higher
      const tempBoost = (temporalResult.isTemporalQuery && refDateForBoost)
        ? temporalProximityBoost(p.created_at, refDateForBoost)
        : 1.0;
      // Importance weighting — critical memories rank higher than low-importance ones
      const importanceWeight = IMPORTANCE_WEIGHTS[p.importance] || 0.7;
      const effectiveScore = +(((r.score || 0.5) * effectiveConfidence * accessBoost * tempBoost * importanceWeight)).toFixed(4);

      // Index format — minimal tokens, IDs + one-line summary for progressive disclosure
      if (isIndex) {
        const text = p.text_compressed || p.text || '';
        const firstLine = text.split('\n').find(l => l.trim()) || text;
        return {
          id: r.id,
          effective_score: effectiveScore,
          type: p.type,
          summary: firstLine.slice(0, 80),
          importance: p.importance,
          client_id: p.client_id,
          created_at: p.created_at,
        };
      }

      if (isCompact) {
        const text = p.text_compressed || p.text || '';
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

    results.sort((a, b) => b.effective_score - a.effective_score);

    // --- Session deduplication in re-ranking ---
    // Ensure results span unique sessions rather than clustering around the most similar one.
    // Parse session_id from metadata or content header.
    if (results.length > 3) {
      const diversified = [];
      const sessionSeen = new Map(); // session_id → count
      const noSession = [];

      for (const r of results) {
        // Try metadata.session_id, then parse from content header "[Session: xxx |"
        let sessionId = r.metadata?.session_id;
        if (!sessionId) {
          const text = r.text || r.content || '';
          const match = text.match(/\[Session:\s*(\S+)/);
          if (match) sessionId = match[1];
        }
        if (!sessionId) { noSession.push(r); continue; }

        const count = sessionSeen.get(sessionId) || 0;
        sessionSeen.set(sessionId, count + 1);
        // Tag with session info for round-robin
        r._sessionId = sessionId;
        r._sessionRank = count;
        diversified.push(r);
      }

      // Round-robin: sort by session rank (0 first from all sessions, then 1, etc.), preserving score within rank
      diversified.sort((a, b) => a._sessionRank - b._sessionRank || b.effective_score - a.effective_score);

      // Merge back: diversified first, then non-session results
      results.length = 0;
      results.push(...diversified, ...noSession);
      // Trim to maxResults
      results.splice(maxResults);
    }

    // Bump access_count + last_accessed_at for the returned results in one atomic
    // SQL statement (fire-and-forget — must not delay the search response).
    const pointIds = results.map(r => r.id);
    if (trackAccess && pointIds.length > 0) {
      bumpAccessCounts(pointIds, new Date().toISOString())
        .catch(e => console.error('[memory:search] Access count update failed:', e.message));
    }

    // Retry with broader, keyword-only terms when the full query returned nothing.
    if (results.length === 0 && searchQuery === q) {
      const broader = extractSearchTerms(q);
      if (broader && broader.length > 3) {
        const retryVector = await embed(broader, 'search');
        const retryResults = await searchPoints(retryVector, filter, maxResults, nestedFilters, rangeFilters);
        if (retryResults.length > 0) {
          for (const r of retryResults) {
            const ec = computeEffectiveConfidence(r.payload);
            const ab = 1 + (0.3 * Math.log2((r.payload.access_count || 0) + 1));
            r._retryScore = +((r.score * ec * ab)).toFixed(4);
          }
          retryResults.sort((a, b) => b._retryScore - a._retryScore);
          const retryFormatted = retryResults.slice(0, maxResults).map(r => ({
            id: r.id, score: r.score, effective_score: r._retryScore, ...r.payload,
          }));
          return res.json({
            query: q, expanded_query: broader, count: retryFormatted.length, results: retryFormatted,
            retry: true,
          });
        }
      }
    }

    const response = {
      query: q,
      count: results.length,
      results,
    };

    // In full format, add retrieval metadata
    if (isFull) {
      response.retrieval = {
        multi_path: useMultiPath,
        paths: useMultiPath ? {
          vector: vectorResults.length,
          keyword: keywordResults.length,
        } : { vector: vectorResults.length },
      };
      if (queryAnalysis.domain) response.retrieval.query_domain = queryAnalysis.domain;
      if (searchQuery !== q) response.retrieval.expanded_query = searchQuery;
      if (temporalResult.isTemporalQuery) response.retrieval.temporal = temporalResult;
    }

    res.json(response);
  } catch (err) {
    logError(req, '[memory:search]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /memory/query — Structured query via database
memoryRouter.get('/query', async (req, res) => {
  try {
    if (!isStoreAvailable()) {
      return res.status(400).json({
        error: 'Structured queries require a database backend. Set STRUCTURED_STORE=postgres in .env.',
      });
    }

    const { type, source_agent, category, client_id, since, key, subject, limit } = req.query;

    let results;
    const filters = { source_agent, category, client_id, limit };

    if (type === 'fact' || type === 'facts') {
      if (key) filters.key = key;
      results = await listFacts(filters);
    } else if (type === 'status' || type === 'statuses') {
      if (subject) filters.subject = subject;
      results = await listStatuses(filters);
    } else {
      // Events and decisions share the events table — pass type filter if specific
      if (since) filters.since = since;
      if (type === 'event' || type === 'decision') filters.type = type;
      results = await listEvents(filters);
    }

    res.json({
      type: type || 'events',
      count: results.results?.length || 0,
      results: results.results || [],
    });
  } catch (err) {
    logError(req, '[memory:query]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /memory/:id — Update an existing memory in place
memoryRouter.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { content, importance, knowledge_category, metadata } = req.body;

    // Must provide at least one field to update
    if (!content && !importance && !knowledge_category && !metadata) {
      return res.status(400).json({ error: 'Must provide at least one field to update: content, importance, knowledge_category, metadata' });
    }

    // Reuse the same validators POST /memory runs. Previously this endpoint
    // persisted whatever shape the caller sent.
    if (content !== undefined) {
      const e = validateContent(content); if (e) return res.status(400).json({ error: e });
    }
    if (importance !== undefined) {
      const e = validateImportance(importance); if (e) return res.status(400).json({ error: e });
    }
    if (knowledge_category !== undefined && !VALID_KNOWLEDGE_CATEGORIES.includes(knowledge_category)) {
      return res.status(400).json({ error: `Invalid knowledge_category: ${knowledge_category}. Must be one of: ${VALID_KNOWLEDGE_CATEGORIES.join(', ')}` });
    }
    if (metadata !== undefined) {
      const e = validateMetadata(metadata); if (e) return res.status(400).json({ error: e });
    }

    const point = await requirePoint(id, res);
    if (!point) return;

    const now = new Date().toISOString();
    const updatedPayload = { updated_at: now };

    // Simple field updates (no re-embed needed)
    if (importance) updatedPayload.importance = importance;
    if (knowledge_category) updatedPayload.knowledge_category = knowledge_category;
    if (metadata) updatedPayload.metadata = scrubObject(metadata);

    // Content change: re-scrub, re-hash, re-embed, re-extract entities, re-index
    if (content) {
      const cleanContent = scrubCredentials(content);
      const contentHash = hashContent(cleanContent);

      updatedPayload.text = cleanContent;
      updatedPayload.content_hash = contentHash;

      let extractedEntities = [];
      try {
        extractedEntities = extractEntities(cleanContent, point.payload.client_id || 'global', point.payload.source_agent);
        if (extractedEntities.length > 0) {
          updatedPayload.entities = extractedEntities.map(e => ({ name: e.name, type: e.type }));
        } else {
          updatedPayload.entities = [];
        }
      } catch (e) {
        console.error('[memory:update:entities] Extraction failed (non-blocking):', e.message);
      }

      const vector = await embed(cleanContent, 'store');
      const mergedPayload = { ...point.payload, ...updatedPayload };
      await upsertPoint(id, vector, mergedPayload);

      if (isKeywordSearchAvailable()) {
        indexMemory(id, cleanContent, {
          client_id: point.payload.client_id || 'global',
          source_agent: point.payload.source_agent,
          type: point.payload.type,
        }).catch(e => console.error('[memory:update:keyword-index]', e.message));
      }

      if (isEntityStoreAvailable() && extractedEntities.length > 0) {
        Promise.resolve().then(async () => {
          try {
            await linkExtractedEntities(extractedEntities, id, { createEntity, findEntity, linkEntityToMemory, createRelationship });
          } catch (e) {
            console.error('[memory:update:entities] Linking failed:', e.message);
          }
        });
      }
    } else {
      // No content change — payload-only update
      await updatePointPayload(id, updatedPayload);
    }

    console.log(`[memory:update] Memory ${id} fields=[${Object.keys(updatedPayload).join(',')}]`);

    res.json({
      id,
      updated: true,
      updated_at: now,
      updated_fields: Object.keys(updatedPayload).filter(k => k !== 'updated_at'),
    });
  } catch (err) {
    logError(req, '[memory:update]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /memory/:id — Soft-delete a memory (mark inactive)
memoryRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const point = await requirePoint(id, res);
    if (!point) return;

    if (point.payload.active === false) {
      return res.status(200).json({ id, already_inactive: true, message: 'Memory was already inactive' });
    }

    const now = new Date().toISOString();
    await updatePointPayload(id, {
      active: false,
      deleted_at: now,
      deletion_reason: reason || null,
    });

    deactivateMemory(id).catch(e => console.error('[memory:keyword-deactivate]', e.message));

    console.log(`[memory:delete] Memory ${id} soft-deleted${reason ? ': ' + reason : ''}`);

    res.json({
      id,
      deleted: true,
      deleted_at: now,
    });
  } catch (err) {
    logError(req, '[memory:delete]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
