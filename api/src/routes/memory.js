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
import { scoreRelevance, relevancePayloadFields } from '../services/relevance-scorer.js';
import { resolveTemporalQuery, temporalProximityBoost } from '../services/temporal-resolver.js';
import { analyzeQuery, expandQuery, extractSearchTerms, getPreferenceKeywords } from '../services/query-expander.js';

const MULTI_PATH_SEARCH = process.env.MULTI_PATH_SEARCH !== 'false'; // default: true
import { getClientResolver } from '../services/client-resolver.js';

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
          valid_to: now, // temporal: old fact no longer valid as of supersede time
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
          valid_to: now, // temporal: old status no longer valid as of supersede time
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
      // Temporal validity (facts and statuses only)
      ...((type === 'fact' || type === 'status') ? {
        valid_from: valid_from || now,
        valid_to: valid_to || null,
      } : {}),
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

    // Embed
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

    // Store in Qdrant
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
      ...(relevanceResult ? { relevance: { score: relevanceResult.score, classification: relevanceResult.classification, signals: relevanceResult.signals } } : {}),
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
    const { q, type, source_agent, client_id, category, limit, include_superseded, entity, format, at_time, reference_date, date_from, date_to, knowledge_category: kc } = req.query;
    const isCompact = format === 'compact';
    const isFull = format === 'full';
    const maxResults = Math.min(parseInt(limit) || 10, 100);

    if (!q) {
      return res.status(400).json({ error: 'Missing required query parameter: q' });
    }

    // --- Fix 7: Query expansion / domain inference ---
    const queryAnalysis = analyzeQuery(q);
    let searchQuery = q;
    if (queryAnalysis.isVague && queryAnalysis.expansions) {
      searchQuery = expandQuery(q, queryAnalysis.expansions);
    }

    // --- Fix 6: Temporal date-range filtering ---
    const temporalResult = resolveTemporalQuery(q, reference_date || at_time);

    const filter = {};
    if (type) filter.type = type;
    if (source_agent) filter.source_agent = source_agent;
    if (client_id) filter.client_id = client_id;
    if (category) filter.category = category;
    if (kc) filter.knowledge_category = kc;
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

    // Temporal validity filter — "what was true at time X?"
    const rangeFilters = [];
    if (at_time) {
      rangeFilters.push({ key: 'valid_from', range: { lte: at_time } });
    }

    // Fix 6: Add date-range filter from temporal resolution or explicit params
    const effectiveDateFrom = date_from || temporalResult.dateFrom;
    const effectiveDateTo = date_to || temporalResult.dateTo;
    if (effectiveDateFrom) {
      rangeFilters.push({ key: 'created_at', range: { gte: effectiveDateFrom } });
    }
    if (effectiveDateTo) {
      rangeFilters.push({ key: 'created_at', range: { lte: effectiveDateTo } });
    }

    // --- Multi-path retrieval ---
    const useMultiPath = MULTI_PATH_SEARCH && !entity; // entity filter is Qdrant-only
    const isPreferenceQuery = queryAnalysis.isPreference;
    // Widen net for preference queries — they need more candidates to find sparse matches
    const fetchLimit = useMultiPath
      ? Math.min(maxResults * (isPreferenceQuery ? 3 : 2), 80)
      : maxResults;

    // Always run vector search (use expanded query for better coverage)
    const vectorPromise = embed(searchQuery, 'search').then(vector =>
      searchPoints(vector, filter, fetchLimit, nestedFilters, rangeFilters)
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

    // Preference keyword path — extra BM25 search with preference indicators + topic
    // Cheap (no embedding call), helps surface memories with explicit preference language
    const prefKeywords = getPreferenceKeywords(q, queryAnalysis);
    const preferenceKeywordPromise = (useMultiPath && isPreferenceQuery && isKeywordSearchAvailable() && prefKeywords)
      ? keywordSearch(prefKeywords, filter, fetchLimit).catch(e => {
          console.error('[memory:preference-keyword-search]', e.message);
          return [];
        })
      : Promise.resolve([]);

    const [vectorResults, keywordResults, graphResults, prefKeywordResults] = await Promise.all([
      vectorPromise, keywordPromise, graphPromise, preferenceKeywordPromise,
    ]);

    // --- Build result set ---
    let finalResults;
    const retrievalSources = {};

    const hasMultiPathResults = keywordResults.length > 0 || graphResults.length > 0
      || prefKeywordResults.length > 0;

    if (useMultiPath && hasMultiPathResults) {
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
      if (prefKeywordResults.length > 0) {
        rankedLists.push(prefKeywordResults.map(r => ({ id: r.memory_id, source: 'preference_keyword' })));
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

    // Apply confidence decay + access-weighted ranking + temporal boost
    const COMPACT_MAX = 200;
    const refDateForBoost = reference_date || at_time || null;
    const results = finalResults.map(r => {
      const effectiveConfidence = computeEffectiveConfidence(r.payload);
      const p = r.payload;
      const accessBoost = 1 + (0.3 * Math.log2((p.access_count || 0) + 1));
      // Fix 6: Temporal proximity boost — memories closer to reference date score higher
      const tempBoost = (temporalResult.isTemporalQuery && refDateForBoost)
        ? temporalProximityBoost(p.created_at, refDateForBoost)
        : 1.0;
      const effectiveScore = +(((r.score || 0.5) * effectiveConfidence * accessBoost * tempBoost)).toFixed(4);

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

    // Re-sort: by date for ordering queries, by effective_score otherwise
    if (temporalResult.orderDirection) {
      const dir = temporalResult.orderDirection === 'asc' ? 1 : -1;
      results.sort((a, b) => {
        const dateA = new Date(a.created_at || 0).getTime();
        const dateB = new Date(b.created_at || 0).getTime();
        return dir * (dateA - dateB);
      });
    } else {
      results.sort((a, b) => b.effective_score - a.effective_score);
    }

    // --- Session diversity re-ranking ---
    // Ensure results span multiple agents/sessions rather than clustering from one source.
    // For multi-agent systems: group by source_agent + date bucket (same agent, same day = same "session").
    // Falls back to metadata.session_id or content header parsing for benchmark compatibility.
    const MAX_PER_SESSION = 3; // cap results from any single session group
    if (results.length > 3 && !temporalResult.orderDirection) {
      const diversified = [];
      const sessionSeen = new Map(); // session_key → count

      for (const r of results) {
        // Determine session key: explicit session_id > source_agent+date > source_agent
        let sessionKey = r.metadata?.session_id;
        if (!sessionKey) {
          const text = r.text || r.content || '';
          const headerMatch = text.match(/\[Session:\s*(\S+)/);
          if (headerMatch) sessionKey = headerMatch[1];
        }
        if (!sessionKey) {
          // Production fallback: group by agent + day
          const agent = r.source_agent || 'unknown';
          const date = r.created_at ? r.created_at.slice(0, 10) : 'unknown';
          sessionKey = `${agent}::${date}`;
        }

        const count = sessionSeen.get(sessionKey) || 0;
        sessionSeen.set(sessionKey, count + 1);
        r._sessionKey = sessionKey;
        r._sessionRank = count; // 0 = first from this session, 1 = second, etc.
        diversified.push(r);
      }

      // Round-robin: take first result from each session, then second, etc.
      // Within the same rank, preserve score order.
      // Cap at MAX_PER_SESSION results per session group.
      diversified.sort((a, b) => a._sessionRank - b._sessionRank || b.effective_score - a.effective_score);

      // Apply per-session cap
      const capped = [];
      const sessionCounts = new Map();
      for (const r of diversified) {
        const cur = sessionCounts.get(r._sessionKey) || 0;
        if (cur < MAX_PER_SESSION) {
          capped.push(r);
          sessionCounts.set(r._sessionKey, cur + 1);
        }
      }

      // Clean internal fields before response
      for (const r of capped) {
        delete r._sessionKey;
        delete r._sessionRank;
      }

      results.length = 0;
      results.push(...capped);
      results.splice(maxResults);
    }

    // Async: increment access_count and update last_accessed_at for returned results (fire-and-forget).
    // We fetch current point payloads in a single batch call before writing to reduce the race
    // window where two concurrent searches both read the same stale access_count from search
    // results and both write count+1 instead of count+2. A tiny race still exists between
    // the getPoints read and the updatePointPayload write, but it is acceptable for a
    // fire-and-forget decay-prevention counter.
    const pointIds = results.map(r => r.id);
    if (pointIds.length > 0) {
      const now = new Date().toISOString();
      getPoints(pointIds)
        .then(freshPoints => {
          const freshById = Object.fromEntries(
            freshPoints.map(p => [p.id, p.payload || {}])
          );
          return Promise.all(
            pointIds.map(id => {
              const current = freshById[id];
              const freshCount = current ? (current.access_count || 0) : 0;
              return updatePointPayload(id, {
                access_count: freshCount + 1,
                last_accessed_at: now,
              });
            })
          );
        })
        .catch(e => {
          console.error('[memory:search] Access count update failed:', e.message);
        });
    }

    // --- Fix 7 part 2: Retry with broader terms on zero results ---
    if (results.length === 0 && searchQuery === q) {
      // Try extracted key terms
      const broader = extractSearchTerms(q);
      if (broader && broader.length > 3) {
        try {
          const retryVector = await embed(broader, 'search');
          const retryResults = await searchPoints(retryVector, filter, maxResults, nestedFilters, rangeFilters);
          if (retryResults.length > 0) {
            // Re-score and return
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
        } catch (e) { /* retry failed, return empty */ }
      }
    }

    const response = {
      query: q,
      count: results.length,
      results,
    };

    // In full format, add retrieval metadata
    if (isFull) {
      const paths = { vector: vectorResults.length };
      if (useMultiPath) {
        paths.keyword = keywordResults.length;
        paths.graph = graphResults.length;
        if (prefKeywordResults.length > 0) paths.preference_keyword = prefKeywordResults.length;
      }
      response.retrieval = {
        multi_path: useMultiPath,
        paths,
      };
      if (queryAnalysis.domain) response.retrieval.query_domain = queryAnalysis.domain;
      if (searchQuery !== q) response.retrieval.expanded_query = searchQuery;
      if (temporalResult.isTemporalQuery) response.retrieval.temporal = temporalResult;
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

// PATCH /memory/:id — Update an existing memory in place
memoryRouter.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { content, importance, knowledge_category, metadata } = req.body;

    // Must provide at least one field to update
    if (!content && !importance && !knowledge_category && !metadata) {
      return res.status(400).json({ error: 'Must provide at least one field to update: content, importance, knowledge_category, metadata' });
    }

    // Fetch existing point
    let point;
    try {
      point = await getPoint(id);
    } catch (e) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    if (!point || !point.payload) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    // Enforce agent identity: agents can only update their own memories
    if (req.authenticatedAgent && point.payload.source_agent !== req.authenticatedAgent) {
      return res.status(403).json({
        error: `Agent "${req.authenticatedAgent}" cannot update memories from "${point.payload.source_agent}"`,
      });
    }

    const now = new Date().toISOString();
    const updatedPayload = { updated_at: now };

    // Simple field updates (no re-embed needed)
    if (importance) updatedPayload.importance = importance;
    if (knowledge_category) updatedPayload.knowledge_category = knowledge_category;
    if (metadata) updatedPayload.metadata = scrubObject(metadata);

    // Content change: re-scrub, re-hash, re-embed, re-extract entities, re-index
    if (content) {
      const cleanContent = scrubCredentials(content);
      const contentHash = crypto.createHash('sha256').update(cleanContent).digest('hex').slice(0, 16);

      updatedPayload.text = cleanContent;
      updatedPayload.content_hash = contentHash;

      // Re-extract entities
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

      // Re-embed and upsert full point (vector + merged payload)
      const vector = await embed(cleanContent, 'store');
      const mergedPayload = { ...point.payload, ...updatedPayload };
      await upsertPoint(id, vector, mergedPayload);

      // Re-index in keyword search
      if (isKeywordSearchAvailable()) {
        indexMemory(id, cleanContent, {
          client_id: point.payload.client_id || 'global',
          source_agent: point.payload.source_agent,
          type: point.payload.type,
        }).catch(e => console.error('[memory:update:keyword-index]', e.message));
      }

      // Re-link entities (fire-and-forget)
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

    console.log(`[memory:update] Memory ${id} updated by ${req.authenticatedAgent || 'admin'} fields=[${Object.keys(updatedPayload).join(',')}]`);

    res.json({
      id,
      updated: true,
      updated_at: now,
      updated_fields: Object.keys(updatedPayload).filter(k => k !== 'updated_at'),
    });
  } catch (err) {
    console.error('[memory:update]', err.message);
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

// POST /memory/batch — Batch ingest multiple memories with controlled parallelism
// Useful for agent bootstrap, migration, and bulk data loading.
const BATCH_CONCURRENCY = parseInt(process.env.BATCH_CONCURRENCY) || 5;
const BATCH_MAX_SIZE = parseInt(process.env.BATCH_MAX_SIZE) || 100;

memoryRouter.post('/batch', async (req, res) => {
  try {
    const { memories } = req.body;

    if (!Array.isArray(memories) || memories.length === 0) {
      return res.status(400).json({ error: 'Request body must contain a non-empty "memories" array' });
    }
    if (memories.length > BATCH_MAX_SIZE) {
      return res.status(400).json({ error: `Batch size ${memories.length} exceeds max ${BATCH_MAX_SIZE}` });
    }

    const results = [];
    let succeeded = 0;
    let failed = 0;
    let deduplicated = 0;

    // Process in chunks of BATCH_CONCURRENCY
    for (let i = 0; i < memories.length; i += BATCH_CONCURRENCY) {
      const chunk = memories.slice(i, i + BATCH_CONCURRENCY);
      const chunkResults = await Promise.allSettled(
        chunk.map(async (mem, idx) => {
          const globalIdx = i + idx;
          try {
            const { type, content, source_agent, client_id, category, importance, knowledge_category, metadata, valid_from, valid_to } = mem;

            if (!type || !content || !source_agent) {
              return { index: globalIdx, error: 'Missing required fields: type, content, source_agent', status: 'failed' };
            }

            // Enforce agent identity
            if (req.authenticatedAgent && source_agent !== req.authenticatedAgent) {
              return { index: globalIdx, error: `Agent identity mismatch`, status: 'failed' };
            }

            const cleanContent = scrubCredentials(content);
            const contentHash = crypto.createHash('sha256').update(cleanContent).digest('hex').slice(0, 16);

            // Dedup check
            const duplicates = await findByPayload('content_hash', contentHash, {
              active: true, client_id: client_id || 'global', type,
            });
            if (duplicates.length > 0) {
              return { index: globalIdx, id: duplicates[0].id, status: 'deduplicated' };
            }

            const now = new Date().toISOString();
            const pointId = crypto.randomUUID();

            // --- Supersedes logic (facts by key, statuses by subject) ---
            let supersedesId = null;
            if (type === 'fact' && mem.key) {
              const matches = await findByPayload('key', mem.key, { active: true, type: 'fact' }, 1);
              if (matches.length > 0) {
                supersedesId = matches[0].id;
                await updatePointPayload(matches[0].id, { active: false, superseded_by: pointId, superseded_at: now, valid_to: now });
                deactivateMemory(matches[0].id).catch(() => {});
              }
            } else if (type === 'status' && mem.subject) {
              const matches = await findByPayload('subject', mem.subject, { active: true, type: 'status' }, 1);
              if (matches.length > 0) {
                supersedesId = matches[0].id;
                await updatePointPayload(matches[0].id, { active: false, superseded_by: pointId, superseded_at: now, valid_to: now });
                deactivateMemory(matches[0].id).catch(() => {});
              }
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
              ...(type === 'fact' && mem.key ? { key: mem.key } : {}),
              ...(type === 'status' && mem.subject ? { subject: mem.subject, status_value: mem.status_value } : {}),
              ...(metadata ? { metadata: scrubObject(metadata) } : {}),
              ...((type === 'fact' || type === 'status') ? {
                valid_from: valid_from || now,
                valid_to: valid_to || null,
              } : {}),
            };

            // Extract entities (fast path)
            let extractedEntities = [];
            try {
              extractedEntities = extractEntities(cleanContent, client_id || 'global', source_agent);
              if (extractedEntities.length > 0) {
                payload.entities = extractedEntities.map(e => ({ name: e.name, type: e.type }));
              }
            } catch (e) { /* non-blocking */ }

            // Embed
            const vector = await embed(cleanContent, 'store');

            // Relevance scoring (reuses vector — no extra embed call)
            try {
              const relevanceResult = await scoreRelevance({
                content: cleanContent, type, importance: importance || 'medium',
                source_agent, entities: extractedEntities, vector, client_id: client_id || 'global',
              });
              Object.assign(payload, relevancePayloadFields(relevanceResult));
            } catch (e) { /* non-blocking */ }

            // Store in Qdrant
            await upsertPoint(pointId, vector, payload);

            // Index in keyword search (fire-and-forget)
            if (isKeywordSearchAvailable()) {
              indexMemory(pointId, cleanContent, {
                client_id: client_id || 'global', source_agent, type,
              }).catch(() => {});
            }

            // Write to structured DB (fire-and-forget)
            if (isStoreAvailable()) {
              const storeData = {
                content: cleanContent, source_agent, client_id: client_id || 'global',
                category: category || 'episodic', importance: importance || 'medium',
                knowledge_category: knowledge_category || 'general', content_hash: contentHash, created_at: now,
              };
              try {
                if (type === 'event' || type === 'decision') {
                  storeData.type = type;
                  createEvent(storeData);
                } else if (type === 'fact') {
                  storeData.key = mem.key || contentHash;
                  storeData.value = cleanContent;
                  upsertFact(storeData);
                } else if (type === 'status') {
                  storeData.subject = mem.subject || 'unknown';
                  storeData.status = mem.status_value || cleanContent;
                  upsertStatus(storeData);
                }
              } catch (e) { /* non-blocking — Qdrant is source of truth */ }
            }

            // Link entities (fire-and-forget)
            if (isEntityStoreAvailable() && extractedEntities.length > 0) {
              linkExtractedEntities(extractedEntities, pointId, { createEntity, findEntity, linkEntityToMemory, createRelationship })
                .catch(e => console.error('[memory:batch:entities]', e.message));
            }

            return { index: globalIdx, id: pointId, status: 'stored', supersedes: supersedesId };
          } catch (err) {
            return { index: globalIdx, error: err.message, status: 'failed' };
          }
        })
      );

      for (const r of chunkResults) {
        const val = r.status === 'fulfilled' ? r.value : { error: r.reason?.message, status: 'failed' };
        results.push(val);
        if (val.status === 'stored') succeeded++;
        else if (val.status === 'deduplicated') deduplicated++;
        else failed++;
      }
    }

    console.log(`[memory:batch] ${succeeded} stored, ${deduplicated} deduped, ${failed} failed (${memories.length} total)`);

    res.status(201).json({
      total: memories.length,
      succeeded,
      deduplicated,
      failed,
      results,
    });
  } catch (err) {
    console.error('[memory:batch]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
