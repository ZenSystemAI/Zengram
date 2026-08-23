import { Router } from 'express';
import crypto from 'crypto';
import { embed } from '../services/embedders/interface.js';
import {
  upsertPoint, searchPoints, updatePointPayload,
  findByPayload, computeEffectiveConfidence, getPoint, getPoints,
  supersedeAndInsert, bumpAccessCounts, recordCorroboration,
} from '../services/pgvector.js';
import {
  createEvent, upsertFact, upsertStatus, listEvents, listFacts, listStatuses, isStoreAvailable,
  isEntityStoreAvailable, createEntity, findEntity, linkEntityToMemory, createRelationship,
} from '../services/stores/interface.js';
import { scrubCredentials, scrubObject, contentHash as hashContent } from '../services/scrub.js';
import { extractEntities, linkExtractedEntities } from '../services/entities.js';
import { validateMemoryInput, validateContent, validateImportance, validateMetadata, VALID_KNOWLEDGE_CATEGORIES } from '../middleware/validate.js';
import { isKeywordSearchAvailable, indexMemory, deactivateMemory, keywordSearch } from '../services/keyword-search.js';
import { reciprocalRankFusion, rrfWeights } from '../services/rrf.js';
import { isRerankAvailable, rerankMemories } from '../services/reranker/interface.js';
import { GRAPH_RETRIEVAL_ENABLED, graphCandidates, rrfGraphWeight } from '../services/graph-retrieval.js';
import { effectiveScore, extractSessionId, diversifyBySession } from '../services/ranking.js';
import { scoreRelevance, relevancePayloadFields } from '../services/relevance-scorer.js';
import { resolveTemporalQuery, temporalProximityBoost } from '../services/temporal-resolver.js';
import { analyzeQuery, expandQuery, extractSearchTerms } from '../services/query-expander.js';
import { truthyParam, falseyParam } from '../services/request-utils.js';
import { logError, errorSummary } from '../lib/log.js';

const MULTI_PATH_SEARCH = process.env.MULTI_PATH_SEARCH !== 'false'; // default: true

// Cross-encoder rerank: fuse a deeper candidate pool, then rerank to top-k.
const RERANK_POOL = parseInt(process.env.RERANK_CANDIDATES) || 40;

// Cap on the observed_by corroboration list — enough to record broad
// cross-agent agreement without letting the payload grow unbounded.
const MAX_OBSERVED_BY = 20;

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

    // source_agent is caller-provided and validated (AGENT_NAME_REGEX) — each
    // agent writes under its own identity so briefings, filters, and
    // cross-agent corroboration work as documented.
    if (!client_id) client_id = 'global';

    const cleanContent = scrubCredentials(content);
    const contentHash = hashContent(cleanContent);

    // --- Deduplication check ---
    // Same agent re-storing identical content returns the existing memory.
    // A DIFFERENT agent storing identical content is cross-agent corroboration:
    // record the observation instead of dropping it.
    const duplicates = await findByPayload('content_hash', contentHash, { active: true, client_id: client_id || 'global', type });
    if (duplicates.length > 0) {
      const existing = duplicates[0];
      // Atomic conditional UPDATE — concurrent corroborations from different
      // agents can't overwrite each other (returns corroborated=false when
      // this agent is already recorded or the observed_by cap is reached).
      let corroboration = { corroborated: false, observedCount: null };
      try {
        corroboration = await recordCorroboration(existing.id, source_agent, MAX_OBSERVED_BY);
      } catch (e) {
        console.error('[memory:corroborate] Failed to record corroboration:', e.message);
      }
      return res.status(200).json({
        id: existing.id,
        type: existing.payload.type,
        content_hash: contentHash,
        deduplicated: true,
        ...(corroboration.corroborated
          ? { corroborated: true, observed_by_count: corroboration.observedCount, message: 'Duplicate content from a different agent — recorded as corroboration' }
          : { message: 'Exact duplicate — returning existing memory' }),
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
      const matches = await findByPayload('key', req.body.key, { active: true, type: 'fact', client_id: client_id || 'global' }, 1);
      if (matches.length > 0) supersedesId = matches[0].id;
    } else if (isKeyedStatus) {
      const matches = await findByPayload('subject', req.body.subject, { active: true, type: 'status', client_id: client_id || 'global' }, 1);
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
    logError(req, '[memory:store]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /memory/search — Multi-path retrieval with RRF fusion
// Paths: vector (semantic) + keyword (Postgres full-text) + optional entity
// graph (GRAPH_RETRIEVAL_ENABLED), with an optional cross-encoder rerank stage
// (RERANK_ENABLED) over the fused pool.
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
    const rerankOn = isRerankAvailable();
    // Fetch deeper than the response limit so fusion + post-filters have real
    // candidates to work with. The old hard cap of 50 silently truncated
    // limit>25 multipath queries. When reranking, fetch at least the rerank
    // pool so the cross-encoder has real candidates to re-score.
    const baseFetch = useMultiPath ? maxResults * 2 : maxResults;
    const fetchLimit = Math.min(Math.max(baseFetch, rerankOn ? RERANK_POOL : 0), 200);

    // Always run vector search (use expanded query for better coverage).
    // An embedding-backend outage must not take the whole search down —
    // capture the failure and degrade to the surviving paths below.
    let vectorError = null;
    const vectorPromise = embed(searchQuery, 'search')
      .then(vector => searchPoints(vector, filter, fetchLimit, nestedFilters, rangeFilters))
      .catch(e => {
        vectorError = e;
        console.error('[memory:search] Vector path failed: %s', errorSummary(e));
        return [];
      });

    // Run keyword in parallel with vector (only if multi-path enabled)
    const keywordPromise = (useMultiPath && isKeywordSearchAvailable())
      ? keywordSearch(q, filter, fetchLimit).catch(e => {
          console.error('[memory:keyword-search]', e.message);
          return [];
        })
      : Promise.resolve([]);

    // Entity-graph third path (opt-in, GRAPH_RETRIEVAL_ENABLED) — additive,
    // returns [] on any failure so it can never break search. Uses the RAW
    // query: expansion synonyms would seed unrelated entities.
    const graphPromise = (useMultiPath && GRAPH_RETRIEVAL_ENABLED)
      ? graphCandidates(q, { clientId: client_id, type, limit: fetchLimit })
      : Promise.resolve([]);

    const [vectorResults, keywordResults, graphResults] = await Promise.all([
      vectorPromise, keywordPromise, graphPromise,
    ]);

    // Vector down and nothing else to answer from → honest 503, not empty 200.
    if (vectorError && keywordResults.length === 0 && graphResults.length === 0) {
      return res.status(503).json({
        error: 'Search unavailable: vector search failed and keyword fallback could not satisfy the query',
        query: q,
        retrieval: { degraded: true, reason: 'vector_search_unavailable' },
      });
    }

    // --- Build candidate set ---
    // Candidates carry their retrieval provenance: simScore (null when found
    // by keyword only — no fabricated similarity) and rrfScore so the final
    // ranking can blend fusion with similarity instead of discarding it.
    let candidates;
    let maxRrfScore = null;
    const retrievalSources = {};

    if (useMultiPath && (keywordResults.length > 0 || graphResults.length > 0)) {
      // Build ranked lists for RRF (vector + keyword + optional graph)
      const rankedLists = [
        vectorResults.map(r => ({ id: r.id, source: 'vector' })),
        keywordResults.map(r => ({ id: r.memory_id, source: 'keyword' })),
        graphResults.map(r => ({ id: r.id, source: 'graph' })),
      ];

      const fused = reciprocalRankFusion(rankedLists, undefined, [...rrfWeights(), rrfGraphWeight()]);
      maxRrfScore = fused.length > 0 ? fused[0].rrf_score : null; // fused is sorted desc

      // Build payload map from vector results (already have full payloads)
      const payloadMap = new Map();
      for (const r of vectorResults) {
        payloadMap.set(r.id, { simScore: r.score, payload: r.payload });
      }

      // Batch-fetch payloads for keyword-only hits (kept for post-filtering +
      // ranking — trimming to maxResults happens after both)
      const missingIds = fused.map(f => f.id).filter(id => !payloadMap.has(id));
      if (missingIds.length > 0) {
        try {
          const fetched = await getPoints(missingIds);
          for (const pt of fetched) {
            payloadMap.set(pt.id, { simScore: null, payload: pt.payload });
          }
        } catch (e) {
          console.error('[memory:search] Batch fetch failed:', e.message);
        }
      }

      candidates = fused.map(f => {
        const entry = payloadMap.get(f.id);
        if (!entry) return null;
        retrievalSources[f.id] = f.sources;
        return { id: f.id, simScore: entry.simScore, payload: entry.payload, rrfScore: f.rrf_score };
      }).filter(Boolean);
    } else {
      // Single-path: vector only
      candidates = vectorResults.map(r => ({ id: r.id, simScore: r.score, payload: r.payload, rrfScore: null }));
    }

    // --- Post-fusion filter parity ---
    // The keyword path only filters client_id/type/source_agent/active in SQL,
    // so keyword-sourced candidates must be re-checked against the remaining
    // filters the vector path already applied. Runs BEFORE the maxResults trim
    // so filtered-out rows don't leave the response short.
    const parseTime = (v) => {
      const t = Date.parse(v);
      return Number.isNaN(t) ? null : t;
    };
    const dateFromMs = effectiveDateFrom ? parseTime(effectiveDateFrom) : null;
    const dateToMs = effectiveDateTo ? parseTime(effectiveDateTo) : null;
    candidates = candidates.filter(({ payload: p }) => {
      if (include_superseded !== 'true' && p.active === false) return false;
      if (category && p.category !== category) return false;
      if (kc && p.knowledge_category !== kc) return false;
      if (source_agent && p.source_agent !== source_agent) return false;
      const createdMs = p.created_at ? parseTime(p.created_at) : null;
      if (dateFromMs !== null && createdMs !== null && createdMs < dateFromMs) return false;
      if (dateToMs !== null && createdMs !== null && createdMs > dateToMs) return false;
      // Temporal validity (at_time) — keyword results bypass the vector path's range filter
      if (at_time) {
        if (p.valid_from && p.valid_from > at_time) return false; // not yet valid
        if (p.valid_to && p.valid_to <= at_time) return false;    // already expired
      }
      return true;
    });

    // --- Cross-encoder rerank (optional, RERANK_ENABLED) ---
    // Re-scores the top of the fused pool by true query↔document relevance.
    // The rerank score replaces the sim/RRF blend inside effectiveScore; the
    // confidence/access/temporal/importance multipliers still apply. Trims to
    // the rerank pool — candidates past it were losing on fused order anyway.
    let reranked = false;
    if (rerankOn && candidates.length > 1) {
      const pool = candidates.slice(0, Math.max(maxResults, RERANK_POOL));
      const out = await rerankMemories(q, pool, {
        textOf: c => c.payload?.text_compressed || c.payload?.text || '',
      });
      if (out.some(r => r.rerank_score != null)) {
        reranked = true;
        candidates = out.map(c => ({
          ...c,
          // Raw cross-encoder logits map through a sigmoid to [0,1] so the
          // ranking multipliers compose the same way they do with similarity.
          rerankScore: c.rerank_score == null ? null
            : (c.rerank_score >= 0 && c.rerank_score <= 1)
              ? c.rerank_score
              : 1 / (1 + Math.exp(-c.rerank_score)),
        }));
      } else {
        candidates = pool; // reranker degraded — keep fused order
      }
    }

    // --- Ranking ---
    // Blend fusion + similarity (or the rerank score when present), multiply
    // confidence decay / capped access boost / temporal proximity / importance
    // (services/ranking.js).
    const refDateForBoost = reference_date || at_time || null;
    for (const c of candidates) {
      const p = c.payload;
      c.effectiveConfidence = computeEffectiveConfidence(p);
      const temporalBoost = (temporalResult.isTemporalQuery && refDateForBoost)
        ? temporalProximityBoost(p.created_at, refDateForBoost)
        : 1.0;
      c.effective_score = effectiveScore({
        simScore: c.simScore,
        rrfScore: c.rrfScore,
        maxRrfScore,
        rerankScore: c.rerankScore,
        effectiveConfidence: c.effectiveConfidence,
        accessCount: p.access_count,
        temporalBoost,
        importance: p.importance,
      });
    }
    candidates.sort((a, b) => b.effective_score - a.effective_score);

    // Session-diversity round-robin (untagged results compete at rank 0), then trim
    const diversified = diversifyBySession(candidates, c => extractSessionId(c.payload));
    const top = diversified.slice(0, maxResults);

    // --- Format ---
    // Shared by the main path and the broader-terms retry so both honor the
    // requested format (the retry must not leak full payloads on compact/index).
    const COMPACT_MAX = 200;
    const formatCandidate = (c) => {
      const p = c.payload;

      // Index format — minimal tokens, IDs + one-line summary for progressive disclosure
      if (isIndex) {
        const text = p.text_compressed || p.text || '';
        const firstLine = text.split('\n').find(l => l.trim()) || text;
        return {
          id: c.id,
          effective_score: c.effective_score,
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
          id: c.id,
          score: +(c.simScore ?? 0).toFixed(4),
          effective_score: c.effective_score,
          type: p.type,
          content: text.length > COMPACT_MAX ? text.slice(0, COMPACT_MAX) + '...' : text,
          source_agent: p.source_agent,
          client_id: p.client_id,
          importance: p.importance,
          created_at: p.created_at,
        };
      }

      const base = {
        id: c.id,
        score: c.simScore ?? 0,
        confidence: c.effectiveConfidence,
        effective_score: c.effective_score,
        ...p,
      };

      // In full format, show which retrieval paths contributed
      if (isFull && retrievalSources[c.id]) {
        base.retrieval_sources = retrievalSources[c.id];
      }

      return base;
    };
    const results = top.map(formatCandidate);

    // Bump access_count + last_accessed_at for the returned results in one atomic
    // SQL statement (fire-and-forget — must not delay the search response).
    const pointIds = top.map(c => c.id);
    if (trackAccess && pointIds.length > 0) {
      bumpAccessCounts(pointIds, new Date().toISOString())
        .catch(e => console.error('[memory:search] Access count update failed:', e.message));
    }

    // Retry with broader, keyword-only terms when the full query returned
    // nothing. Skipped when the vector path is down — the retry re-embeds.
    if (results.length === 0 && searchQuery === q && !vectorError) {
      const broader = extractSearchTerms(q);
      if (broader && broader.length > 3) {
        const retryVector = await embed(broader, 'search');
        const retryResults = await searchPoints(retryVector, filter, maxResults, nestedFilters, rangeFilters);
        if (retryResults.length > 0) {
          const retryScored = retryResults.map(r => {
            const effectiveConfidence = computeEffectiveConfidence(r.payload);
            return {
              id: r.id,
              payload: r.payload,
              simScore: r.score,
              effectiveConfidence,
              effective_score: effectiveScore({
                simScore: r.score,
                rrfScore: null,
                maxRrfScore: null,
                effectiveConfidence,
                accessCount: r.payload.access_count,
                importance: r.payload.importance,
              }),
            };
          });
          retryScored.sort((a, b) => b.effective_score - a.effective_score);
          const retryFormatted = retryScored.slice(0, maxResults).map(formatCandidate);
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
          ...(GRAPH_RETRIEVAL_ENABLED ? { graph: graphResults.length } : {}),
        } : { vector: vectorResults.length },
      };
      if (rerankOn) response.retrieval.reranked = reranked;
      if (queryAnalysis.domain) response.retrieval.query_domain = queryAnalysis.domain;
      if (searchQuery !== q) response.retrieval.expanded_query = searchQuery;
      if (temporalResult.isTemporalQuery) response.retrieval.temporal = temporalResult;
    }

    // A degraded search must say so regardless of format — an empty-but-200
    // response during a vector outage reads as "no memories exist".
    if (vectorError) {
      response.retrieval = {
        ...(response.retrieval || {}),
        degraded: true,
        reason: 'vector_search_unavailable',
      };
    }

    res.json(response);
  } catch (err) {
    logError(req, '[memory:search]', err);
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
    logError(req, '[memory:query]', err);
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
    logError(req, '[memory:update]', err);
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
    logError(req, '[memory:delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
