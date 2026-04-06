import crypto from 'crypto';
import { complete, getLLMInfo } from './llm/interface.js';
import { scrollPoints, updatePointPayload, upsertPoint, findByPayload, searchPoints } from './qdrant.js';
import { embed } from './embedders/interface.js';
import {
  isEntityStoreAvailable, isStoreAvailable, createEntity, findEntity, linkEntityToMemory,
  upsertAlias, loadAllAliases,
} from './stores/interface.js';
import { isKeywordSearchAvailable, indexMemory } from './keyword-search.js';
import { loadAliasCache, addToAliasCache } from './entities.js';
import { dispatchNotification } from './notifications.js';

const SEMANTIC_DEDUP_THRESHOLD = 0.92; // Skip if existing memory is >92% similar

// Consolidation run history (in-memory, persisted via Qdrant events)
let lastRunAt = null;
let isRunning = false;

// Job tracking for async consolidation
const jobs = new Map(); // jobId → { status, startedAt, result, error }

const CONSOLIDATION_PROMPT = `You are analyzing a batch of agent memories from a shared brain system. These memories were stored by different AI agents working on different machines.

Analyze the following memories and produce a JSON response with these fields:

{
  "merged_facts": [
    {
      "content": "The consolidated fact combining multiple memories",
      "source_memories": ["id1", "id2"],
      "key": "a-unique-key-for-this-fact",
      "client_id": "global or client slug",
      "importance": "critical|high|medium|low"
    }
  ],
  "contradictions": [
    {
      "memory_a": "id of first memory",
      "memory_b": "id of second memory",
      "description": "What the contradiction is",
      "suggested_resolution": "Which one is likely correct and why"
    }
  ],
  "connections": [
    {
      "memories": ["id1", "id2"],
      "relationship": "Description of how these memories are related"
    }
  ],
  "compressed_summaries": [
    {
      "content": "A compressed 2-3 sentence summary of this group of related memories",
      "source_memories": ["id1", "id2", "id3"],
      "key": "unique-key-for-summary",
      "client_id": "global or client slug",
      "importance": "critical|high|medium|low"
    }
  ],
  "knowledge_categories": [
    {
      "memory_id": "id of memory to reclassify",
      "suggested_category": "brand|strategy|meeting|content|technical|relationship|general"
    }
  ]
}

Rules:
- Only create merged_facts when 2+ memories say essentially the same thing
- Only flag contradictions when memories genuinely conflict (not just different aspects)
- Connections should be meaningful, not trivial (e.g., same client mentioned)
- compressed_summaries: For groups of 3+ events describing the same session or topic, produce a compressed summary (2-3 sentences max). This replaces verbose session logs with concise facts.
- Do NOT extract or discover entities — entity extraction is handled separately at write time.
- insights: ALWAYS return an empty array. Do NOT generate insights.
- entities: ALWAYS return an empty array. Entity extraction happens at write time, not consolidation.
- entity_relationship_types: ALWAYS return an empty array. Relationships are inferred from co-occurrence at write time.
- If no merges/contradictions/connections/compressed_summaries found, return empty arrays
- Preserve client_id from source memories
- For each memory, suggest the most appropriate knowledge_category from: brand, strategy, meeting, content, technical, relationship, general. Consider: brand=voice/identity/guidelines, strategy=plans/positioning/campaigns, meeting=call notes/action items, content=published work/performance, technical=hosting/CMS/SEO issues, relationship=contacts/preferences. Only include a memory in knowledge_categories if you are suggesting a category different from its current knowledge_category attribute (or if the current one is null/general and a more specific one fits).

MEMORIES TO ANALYZE:
`;

export async function runConsolidation() {
  if (isRunning) {
    return { status: 'skipped', reason: 'Consolidation already running' };
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    // Pull ALL unconsolidated memories (paginated)
    const points = [];
    let scrollOffset = null;
    do {
      const result = await scrollPoints({ consolidated: false }, 200, scrollOffset);
      const page = result.points || [];
      points.push(...page);
      scrollOffset = result.next_page_offset || null;
    } while (scrollOffset);

    if (points.length === 0) {
      isRunning = false;
      lastRunAt = new Date().toISOString();
      return { status: 'complete', memories_processed: 0, message: 'No unconsolidated memories found' };
    }

    // Group by client_id for focused analysis
    const groups = {};
    for (const point of points) {
      const clientId = point.payload.client_id || 'global';
      if (!groups[clientId]) groups[clientId] = [];
      groups[clientId].push(point);
    }

    let totalMerged = 0;
    let totalContradictions = 0;
    let totalConnections = 0;
    let totalCompressedSummaries = 0;
    let totalSkipped = 0;
    let totalCategoriesUpdated = 0;
    const errors = [];

    for (const [clientId, groupPoints] of Object.entries(groups)) {
      // Process in batches of 50 to stay within context limits
      for (let i = 0; i < groupPoints.length; i += 50) {
        const batch = groupPoints.slice(i, i + 50);

        try {
          const result = await consolidateBatch(batch, clientId);
          totalMerged += result.merged;
          totalContradictions += result.contradictions;
          totalConnections += result.connections;
          totalCompressedSummaries += result.compressed_summaries || 0;
          totalSkipped += result.skipped || 0;
          totalCategoriesUpdated += result.categories_updated || 0;

          // Mark batch as consolidated
          const ids = batch.map(p => p.id);
          await updatePointPayload(ids, { consolidated: true, consolidated_at: new Date().toISOString() });
        } catch (err) {
          errors.push({ client_id: clientId, batch_start: i, error: err.message });
          console.error(`[consolidation] Batch error for ${clientId}:`, err.message);
        }
      }
    }

    const duration = Date.now() - startTime;
    lastRunAt = new Date().toISOString();
    isRunning = false;

    const summary = {
      status: 'complete',
      memories_processed: points.length,
      groups_processed: Object.keys(groups).length,
      merged_facts: totalMerged,
      contradictions_found: totalContradictions,
      connections_found: totalConnections,
      compressed_summaries: totalCompressedSummaries,
      skipped_dedup: totalSkipped,
      categories_updated: totalCategoriesUpdated,
      errors: errors.length > 0 ? errors : undefined,
      duration_ms: duration,
      llm: getLLMInfo(),
    };

    // Refresh alias cache after consolidation (new aliases may have been discovered)
    if (isEntityStoreAvailable()) {
      try {
        const aliases = await loadAllAliases();
        loadAliasCache(aliases);
      } catch (e) {
        console.error('[consolidation] Alias cache refresh failed:', e.message);
      }
    }

    // Clean up old, low-value events (>30 days, never accessed, medium/low importance)
    let eventsExpired = 0;
    try {
      eventsExpired = await cleanupOldEvents();
    } catch (e) {
      console.error('[consolidation] Event cleanup failed:', e.message);
    }
    summary.events_expired = eventsExpired;

    console.log(`[consolidation] Complete: ${points.length} memories, ${totalMerged} merged, ${totalContradictions} contradictions, ${totalConnections} connections, ${totalCompressedSummaries} compressed summaries, ${totalSkipped} skipped (dedup), ${totalCategoriesUpdated} categories updated, ${eventsExpired} events expired`);

    return summary;
  } catch (err) {
    isRunning = false;
    throw err;
  }
}

async function consolidateBatch(points, clientId) {
  // Collect valid IDs for output validation
  const batchIds = new Set(points.map(p => p.id));

  // Format memories for the LLM — wrapped in XML tags to resist prompt injection
  const escapeXml = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const memoriesText = points.map(p => {
    const pay = p.payload;
    const safeText = escapeXml(pay.text);
    const safeAgent = escapeXml(pay.source_agent || '');
    const safeClient = escapeXml(pay.client_id || '');
    const safeKnowledgeCategory = escapeXml(pay.knowledge_category || '');
    return `<memory id="${p.id}" type="${pay.type}" agent="${safeAgent}" client="${safeClient}" knowledge_category="${safeKnowledgeCategory}" created="${pay.created_at}">\n${safeText}\n</memory>`;
  }).join('\n\n');

  const prompt = CONSOLIDATION_PROMPT + memoriesText;
  const responseText = await complete(prompt);

  let result;
  try {
    // Strip markdown code fences the LLM may wrap around the JSON
    let jsonText = responseText.trim();
    const fenceMatch = jsonText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();
    result = JSON.parse(jsonText);
  } catch (e) {
    console.error('[consolidation] LLM returned invalid JSON:', responseText.slice(0, 300));
    return { merged: 0, contradictions: 0, connections: 0, compressed_summaries: 0 };
  }

  // Validate top-level structure
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    console.error('[consolidation] LLM returned non-object JSON');
    return { merged: 0, contradictions: 0, connections: 0, compressed_summaries: 0 };
  }

  // Validate: strip any memory IDs not in the current batch
  if (result.merged_facts) {
    for (const fact of result.merged_facts) {
      if (fact.source_memories) {
        fact.source_memories = fact.source_memories.filter(id => batchIds.has(id));
      }
    }
  }
  if (result.contradictions) {
    result.contradictions = result.contradictions.filter(c =>
      batchIds.has(c.memory_a) && batchIds.has(c.memory_b)
    );
  }
  if (result.connections) {
    for (const conn of result.connections) {
      if (conn.memories) {
        conn.memories = conn.memories.filter(id => batchIds.has(id));
      }
    }
    result.connections = result.connections.filter(c => c.memories && c.memories.length >= 2);
  }
  if (result.compressed_summaries) {
    for (const summary of result.compressed_summaries) {
      if (summary.source_memories) {
        summary.source_memories = summary.source_memories.filter(id => batchIds.has(id));
      }
    }
    result.compressed_summaries = result.compressed_summaries.filter(s => s.source_memories && s.source_memories.length >= 3);
  }
  // Validate knowledge_categories: only accept entries with valid memory IDs and valid categories
  const VALID_KNOWLEDGE_CATEGORIES = ['brand', 'strategy', 'meeting', 'content', 'technical', 'relationship', 'general'];
  if (result.knowledge_categories) {
    result.knowledge_categories = result.knowledge_categories.filter(kc =>
      kc.memory_id && batchIds.has(kc.memory_id) &&
      kc.suggested_category && VALID_KNOWLEDGE_CATEGORIES.includes(kc.suggested_category)
    );
  }

  const VALID_IMPORTANCE = ['critical', 'high', 'medium', 'low'];
  const sanitizeImportance = (val) => VALID_IMPORTANCE.includes(val) ? val : 'medium';

  const now = new Date().toISOString();
  let merged = 0, contradictions = 0, connections = 0, compressedSummaries = 0;

  // Store merged facts as new memories (with dedup)
  let skipped = 0;
  if (result.merged_facts?.length > 0) {
    for (const fact of result.merged_facts) {
      const content = fact.content;
      const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

      // Exact dedup: skip if identical content already exists
      const existing = await findByPayload('content_hash', contentHash, { active: true });
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const vector = await embed(content, 'store');

      // Semantic dedup: skip if a very similar memory already exists
      const similar = await searchPoints(vector, { active: true }, 1);
      if (similar.length > 0 && similar[0].score >= SEMANTIC_DEDUP_THRESHOLD) {
        skipped++;
        continue;
      }

      const mergedId = crypto.randomUUID();
      await upsertPoint(mergedId, vector, {
        text: content,
        type: 'fact',
        source_agent: 'consolidation-engine',
        client_id: fact.client_id || clientId,
        category: 'semantic',
        importance: sanitizeImportance(fact.importance),
        key: fact.key || contentHash,
        content_hash: contentHash,
        created_at: now,
        last_accessed_at: now,
        access_count: 0,
        confidence: 1.0,
        active: true,
        consolidated: true,
        metadata: { source_memories: fact.source_memories, consolidation_type: 'merged' },
      });

      // Index in keyword search (so merged facts appear in BM25 results)
      if (isKeywordSearchAvailable()) {
        indexMemory(mergedId, content, {
          client_id: fact.client_id || clientId,
          source_agent: 'consolidation-engine',
          type: 'fact',
        }).catch(e => console.error('[consolidation:keyword-index]', e.message));
      }

      // Write to structured DB (so merged facts appear in /memory/query)
      if (isStoreAvailable()) {
        const { upsertFact } = await import('./stores/interface.js');
        upsertFact({
          key: fact.key || contentHash,
          value: content,
          content,
          source_agent: 'consolidation-engine',
          client_id: fact.client_id || clientId,
          category: 'semantic',
          importance: sanitizeImportance(fact.importance),
          knowledge_category: 'general',
          content_hash: contentHash,
          created_at: now,
        }).catch(e => console.error('[consolidation:store-fact]', e.message));
      }

      // Supersede source memories — the merged fact replaces them
      if (fact.source_memories?.length > 0) {
        for (const sourceId of fact.source_memories) {
          try {
            await updatePointPayload(sourceId, {
              active: false,
              superseded_by: mergedId,
              superseded_at: now,
            });
            // Find the source point in the batch to get its payload for the notification
            const sourcePoint = points.find(p => p.id === sourceId);
            if (sourcePoint) {
              dispatchNotification('memory_superseded', { id: sourceId, ...sourcePoint.payload });
            }
          } catch (e) {
            // Source memory might not exist — skip
          }
        }
      }
      merged++;
    }
  }

  // Store contradictions as decision-type memories (need human/agent review)
  if (result.contradictions?.length > 0) {
    for (const contradiction of result.contradictions) {
      const content = `CONTRADICTION DETECTED: ${contradiction.description}. Suggested resolution: ${contradiction.suggested_resolution}`;
      const vector = await embed(content, 'store');
      const contradictionId = crypto.randomUUID();
      const contradictionHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
      await upsertPoint(contradictionId, vector, {
        text: content,
        type: 'event',
        source_agent: 'consolidation-engine',
        client_id: clientId,
        category: 'episodic',
        importance: 'high',
        content_hash: contradictionHash,
        created_at: now,
        last_accessed_at: now,
        access_count: 0,
        confidence: 1.0,
        active: true,
        consolidated: true,
        metadata: {
          consolidation_type: 'contradiction',
          memory_a: contradiction.memory_a,
          memory_b: contradiction.memory_b,
        },
      });

      // Index contradiction in keyword search + structured DB
      if (isKeywordSearchAvailable()) {
        indexMemory(contradictionId, content, {
          client_id: clientId, source_agent: 'consolidation-engine', type: 'event',
        }).catch(e => console.error('[consolidation:keyword-index]', e.message));
      }
      if (isStoreAvailable()) {
        const { createEvent } = await import('./stores/interface.js');
        createEvent({
          content, type: 'event', source_agent: 'consolidation-engine',
          client_id: clientId, category: 'episodic', importance: 'high',
          knowledge_category: 'general', content_hash: contradictionHash, created_at: now,
        }).catch(e => console.error('[consolidation:store-event]', e.message));
      }

      contradictions++;
    }
  }

  // Update connection metadata on existing points
  if (result.connections?.length > 0) {
    for (const connection of result.connections) {
      for (const memoryId of (connection.memories || [])) {
        try {
          await updatePointPayload(memoryId, {
            connections: connection.memories.filter(id => id !== memoryId),
            connection_description: connection.relationship,
          });
        } catch (e) {
          // Point might not exist — skip
        }
      }
      connections++;
    }
  }

  // Store compressed summaries as new fact-type memories (without superseding source memories)
  if (result.compressed_summaries?.length > 0) {
    for (const summary of result.compressed_summaries) {
      const content = summary.content;
      const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

      // Exact dedup: skip if identical content already exists
      const existing = await findByPayload('content_hash', contentHash, { active: true });
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const vector = await embed(content, 'store');

      // Semantic dedup: skip if a very similar memory already exists
      const similar = await searchPoints(vector, { active: true }, 1);
      if (similar.length > 0 && similar[0].score >= SEMANTIC_DEDUP_THRESHOLD) {
        skipped++;
        continue;
      }

      const summaryId = crypto.randomUUID();
      await upsertPoint(summaryId, vector, {
        text: content,
        type: 'fact',
        source_agent: 'consolidation-engine',
        client_id: summary.client_id || clientId,
        category: 'semantic',
        importance: sanitizeImportance(summary.importance),
        key: summary.key || contentHash,
        content_hash: contentHash,
        created_at: now,
        last_accessed_at: now,
        access_count: 0,
        confidence: 1.0,
        active: true,
        consolidated: true,
        metadata: { source_memories: summary.source_memories, consolidation_type: 'compressed_summary' },
      });

      // Index in keyword search
      if (isKeywordSearchAvailable()) {
        indexMemory(summaryId, content, {
          client_id: summary.client_id || clientId,
          source_agent: 'consolidation-engine',
          type: 'fact',
        }).catch(e => console.error('[consolidation:keyword-index]', e.message));
      }

      // Write to structured DB
      if (isStoreAvailable()) {
        const { upsertFact } = await import('./stores/interface.js');
        upsertFact({
          key: summary.key || contentHash,
          value: content,
          content,
          source_agent: 'consolidation-engine',
          client_id: summary.client_id || clientId,
          category: 'semantic',
          importance: sanitizeImportance(summary.importance),
          knowledge_category: 'general',
          content_hash: contentHash,
          created_at: now,
        }).catch(e => console.error('[consolidation:store-fact]', e.message));
      }

      // Mark source memories as consolidated (but don't supersede them)
      if (summary.source_memories?.length > 0) {
        for (const sourceId of summary.source_memories) {
          try {
            await updatePointPayload(sourceId, {
              consolidated: true,
              consolidated_at: now,
            });
          } catch (e) {
            // Source memory might not exist — skip
          }
        }
      }

      compressedSummaries++;
    }
  }

  // Reclassify knowledge_category for memories where the LLM suggests a better fit
  let categoriesUpdated = 0;
  if (result.knowledge_categories?.length > 0) {
    for (const kc of result.knowledge_categories) {
      try {
        // Find the point in the batch to check current knowledge_category
        const point = points.find(p => p.id === kc.memory_id);
        const currentCategory = point?.payload?.knowledge_category;

        // Only reclassify if current is null, empty, or 'general'
        if (!currentCategory || currentCategory === 'general' || currentCategory === '') {
          await updatePointPayload(kc.memory_id, { knowledge_category: kc.suggested_category });
          categoriesUpdated++;
        }
      } catch (e) {
        // Point might not exist — skip
      }
    }
    if (categoriesUpdated > 0) {
      console.log(`[consolidation] Reclassified ${categoriesUpdated} memories with knowledge_category`);
    }
  }

  return {
    merged, contradictions, connections, compressed_summaries: compressedSummaries, skipped,
    categories_updated: categoriesUpdated,
  };
}

const EVENT_TTL_DAYS = parseInt(process.env.EVENT_TTL_DAYS) || 30;

async function cleanupOldEvents() {
  const cutoff = new Date(Date.now() - EVENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Scroll events page-by-page, filtering and expiring in each page (no bulk load)
  let scrollOffset = null;
  let totalExpired = 0;

  do {
    const result = await scrollPoints({ type: 'event', active: true }, 200, scrollOffset);
    const page = result.points || [];
    scrollOffset = result.next_page_offset || null;

    // Filter for old, unused, low-importance events within this page
    const toExpire = page.filter(p => {
      const pay = p.payload;
      return (pay.access_count || 0) === 0 &&
        pay.created_at && pay.created_at < cutoff &&
        (pay.importance === 'medium' || pay.importance === 'low');
    });

    if (toExpire.length > 0) {
      const ids = toExpire.map(p => p.id);
      await updatePointPayload(ids, { active: false, expired_at: new Date().toISOString() });
      totalExpired += ids.length;
    }

    // Safety cap: don't expire more than 500 in one run
    if (totalExpired >= 500) break;
  } while (scrollOffset);

  if (totalExpired > 0) {
    console.log(`[consolidation] Expired ${totalExpired} old events (>${EVENT_TTL_DAYS} days, never accessed, medium/low importance)`);
  }
  return totalExpired;
}

export function startConsolidationJob() {
  if (isRunning) {
    return { status: 'skipped', reason: 'Consolidation already running' };
  }
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'running', startedAt: new Date().toISOString(), result: null, error: null });

  // Run in background — don't await
  runConsolidation().then(result => {
    jobs.set(jobId, { status: 'complete', startedAt: jobs.get(jobId)?.startedAt, result, error: null });
    // Auto-clean jobs older than 1 hour
    setTimeout(() => jobs.delete(jobId), 3_600_000);
  }).catch(err => {
    jobs.set(jobId, { status: 'failed', startedAt: jobs.get(jobId)?.startedAt, result: null, error: err.message });
    setTimeout(() => jobs.delete(jobId), 3_600_000);
  });

  return { status: 'started', job_id: jobId };
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function getConsolidationStatus() {
  return {
    is_running: isRunning,
    last_run_at: lastRunAt,
    llm: getLLMInfo(),
    enabled: process.env.CONSOLIDATION_ENABLED !== 'false',
    interval: process.env.CONSOLIDATION_INTERVAL || '0 */6 * * *',
  };
}
