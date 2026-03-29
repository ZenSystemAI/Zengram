import crypto from 'crypto';
import { complete, getLLMInfo } from './llm/interface.js';
import { scrollPoints, updatePointPayload, upsertPoint, findByPayload, searchPoints } from './qdrant.js';
import { embed } from './embedders/interface.js';
import { isEntityStoreAvailable, createEntity, findEntity, linkEntityToMemory, upsertAlias, loadAllAliases, createRelationship } from './stores/interface.js';
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
  "insights": [],
  "entities": [
    {
      "canonical_name": "The standard/official name for this entity",
      "type": "client|person|system|service|domain|technology|workflow|agent",
      "aliases": ["other-name", "abbreviation", "slug"],
      "mentioned_in": ["memory-id-1", "memory-id-2"]
    }
  ],
  "knowledge_categories": [
    {
      "memory_id": "id of memory to reclassify",
      "suggested_category": "brand|strategy|meeting|content|technical|relationship|general"
    }
  ],
  "entity_relationship_types": [
    {
      "source_entity": "canonical name of first entity",
      "target_entity": "canonical name of second entity",
      "relationship_type": "contact_of|same_owner|uses|works_on|competitor_of|co_occurrence"
    }
  ]
}

Rules:
- Only create merged_facts when 2+ memories say essentially the same thing
- Only flag contradictions when memories genuinely conflict (not just different aspects)
- Connections should be meaningful, not trivial (e.g., same client mentioned)
- insights: ALWAYS return an empty array. Do NOT generate insights — they create noise.
- If no merges/contradictions/connections/insights found, return empty arrays
- Preserve client_id from source memories
- Extract ALL named entities: client names, people, systems, services, domains, technologies, workflows, agent names
- For each entity, choose the most official/complete form as canonical_name (e.g. "Acme Corporation" not "acme")
- List ALL variant spellings/references as aliases (include slugs, abbreviations, informal names)
- type must be one of: client, person, system, service, domain, technology, workflow, agent
- mentioned_in must only contain memory IDs from the batch being analyzed
- If an entity appears in source_agent fields, its type is "agent"
- If an entity appears in client_id fields, its type is "client"
- Domain names (*.com, *.ca, etc.) have type "domain"
- Tools and software have type "technology"
- For each memory, suggest the most appropriate knowledge_category from: brand, strategy, meeting, content, technical, relationship, general. Consider: brand=voice/identity/guidelines, strategy=plans/positioning/campaigns, meeting=call notes/action items, content=published work/performance, technical=hosting/CMS/SEO issues, relationship=contacts/preferences. Only include a memory in knowledge_categories if you are suggesting a category different from its current knowledge_category attribute (or if the current one is null/general and a more specific one fits).
- For pairs of entities that frequently appear together in the memories, suggest a relationship type from: contact_of, same_owner, uses, works_on, competitor_of, co_occurrence. Only suggest relationships when the memory content makes the relationship clear.

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
    let totalInsights = 0;
    let totalSkipped = 0;
    let totalEntities = 0;
    let totalCategoriesUpdated = 0;
    let totalRelationshipsCreated = 0;
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
          totalInsights += result.insights;
          totalSkipped += result.skipped || 0;
          totalEntities += result.entities || 0;
          totalCategoriesUpdated += result.categories_updated || 0;
          totalRelationshipsCreated += result.relationships_created || 0;

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
      insights_generated: totalInsights,
      skipped_dedup: totalSkipped,
      entities_processed: totalEntities,
      categories_updated: totalCategoriesUpdated,
      relationships_created: totalRelationshipsCreated,
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

    console.log(`[consolidation] Complete: ${points.length} memories, ${totalMerged} merged, ${totalContradictions} contradictions, ${totalConnections} connections, ${totalInsights} insights, ${totalSkipped} skipped (dedup), ${totalEntities} entities, ${totalCategoriesUpdated} categories updated, ${totalRelationshipsCreated} relationships, ${eventsExpired} events expired`);

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
    return { merged: 0, contradictions: 0, connections: 0, insights: 0 };
  }

  // Validate top-level structure
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    console.error('[consolidation] LLM returned non-object JSON');
    return { merged: 0, contradictions: 0, connections: 0, insights: 0 };
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
  if (result.insights) {
    for (const insight of result.insights) {
      if (insight.source_memories) {
        insight.source_memories = insight.source_memories.filter(id => batchIds.has(id));
      }
    }
  }
  if (result.entities) {
    for (const ent of result.entities) {
      if (ent.mentioned_in) {
        ent.mentioned_in = ent.mentioned_in.filter(id => batchIds.has(id));
      }
    }
  }
  // Validate knowledge_categories: only accept entries with valid memory IDs and valid categories
  const VALID_KNOWLEDGE_CATEGORIES = ['brand', 'strategy', 'meeting', 'content', 'technical', 'relationship', 'general'];
  if (result.knowledge_categories) {
    result.knowledge_categories = result.knowledge_categories.filter(kc =>
      kc.memory_id && batchIds.has(kc.memory_id) &&
      kc.suggested_category && VALID_KNOWLEDGE_CATEGORIES.includes(kc.suggested_category)
    );
  }
  // Validate entity_relationship_types: only accept entries with valid relationship types
  const VALID_RELATIONSHIP_TYPES = ['contact_of', 'same_owner', 'uses', 'works_on', 'competitor_of', 'co_occurrence'];
  if (result.entity_relationship_types) {
    result.entity_relationship_types = result.entity_relationship_types.filter(ert =>
      ert.source_entity && ert.target_entity && ert.relationship_type &&
      VALID_RELATIONSHIP_TYPES.includes(ert.relationship_type)
    );
  }

  const VALID_IMPORTANCE = ['critical', 'high', 'medium', 'low'];
  const sanitizeImportance = (val) => VALID_IMPORTANCE.includes(val) ? val : 'medium';

  const now = new Date().toISOString();
  let merged = 0, contradictions = 0, connections = 0, insights = 0;

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
      await upsertPoint(crypto.randomUUID(), vector, {
        text: content,
        type: 'event',
        source_agent: 'consolidation-engine',
        client_id: clientId,
        category: 'episodic',
        importance: 'high',
        content_hash: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
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

  // Insights DISABLED (2026-03-19): LLM-generated insights about memory content
  // are a noise factory. They produce generic observations that compete with source
  // memories in search results. Real insights come from agents doing actual work.
  // The consolidation engine should merge, connect, and extract entities — not philosophize.
  if (result.insights?.length > 0) {
    console.log(`[consolidation] Skipped ${result.insights.length} insights (generation disabled)`);
  }

  // Process entities discovered by the LLM
  let entitiesProcessed = 0;
  if (result.entities?.length > 0 && isEntityStoreAvailable()) {
    for (const ent of result.entities) {
      try {
        // Normalize: trim whitespace, collapse internal spaces
        const canonicalName = (ent.canonical_name || '').trim().replace(/\s+/g, ' ');
        if (!canonicalName || canonicalName.length < 2) continue;

        const entityType = ent.type || 'system';

        // Find or create the entity (findEntity already does case-insensitive lookup)
        let entity = await findEntity(canonicalName);
        let entityId;
        if (entity) {
          entityId = entity.id;
          // Bump mention count
          await createEntity({ canonical_name: entity.canonical_name, entity_type: entityType });
        } else {
          const created = await createEntity({ canonical_name: canonicalName, entity_type: entityType });
          entityId = created.id;
          addToAliasCache(canonicalName, entityId, canonicalName, entityType);
        }

        // Register aliases (normalized)
        if (ent.aliases && entityId) {
          for (const rawAlias of ent.aliases) {
            const alias = (rawAlias || '').trim().replace(/\s+/g, ' ');
            if (!alias || alias.length < 2) continue;
            const aliasResult = await upsertAlias(entityId, alias);
            if (aliasResult.created) {
              addToAliasCache(alias, entityId, canonicalName, entityType);
            }
          }
        }

        // Link to mentioned memories
        if (ent.mentioned_in && entityId) {
          for (const memId of ent.mentioned_in) {
            await linkEntityToMemory(entityId, memId, 'mentioned');
          }
        }

        entitiesProcessed++;
      } catch (e) {
        console.error(`[consolidation] Entity processing failed for "${ent.canonical_name}":`, e.message);
      }
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

  // Create entity relationships based on LLM-suggested types
  let relationshipsCreated = 0;
  if (result.entity_relationship_types?.length > 0 && isEntityStoreAvailable()) {
    for (const ert of result.entity_relationship_types) {
      try {
        const sourceEntity = await findEntity(ert.source_entity);
        const targetEntity = await findEntity(ert.target_entity);

        if (sourceEntity && targetEntity && sourceEntity.id !== targetEntity.id) {
          await createRelationship(sourceEntity.id, targetEntity.id, ert.relationship_type);
          relationshipsCreated++;
        }
      } catch (e) {
        console.error(`[consolidation] Relationship creation failed for "${ert.source_entity}" -> "${ert.target_entity}":`, e.message);
      }
    }
    if (relationshipsCreated > 0) {
      console.log(`[consolidation] Created/updated ${relationshipsCreated} entity relationships`);
    }
  }

  return {
    merged, contradictions, connections, insights, skipped,
    entities: entitiesProcessed,
    categories_updated: categoriesUpdated,
    relationships_created: relationshipsCreated,
  };
}

const EVENT_TTL_DAYS = parseInt(process.env.EVENT_TTL_DAYS) || 30;

async function cleanupOldEvents() {
  const cutoff = new Date(Date.now() - EVENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Scroll ALL events (paginated), then filter for old/unused/low-importance
  const allEvents = [];
  let scrollOffset = null;
  do {
    const result = await scrollPoints({ type: 'event' }, 200, scrollOffset);
    const page = result.points || [];
    allEvents.push(...page);
    scrollOffset = result.next_page_offset || null;
  } while (scrollOffset);

  const points = allEvents.filter(p => {
    const pay = p.payload;
    return pay.active === true &&
      pay.access_count === 0 &&
      pay.created_at < cutoff &&
      (pay.importance === 'medium' || pay.importance === 'low');
  });

  if (points.length === 0) return 0;

  // Mark as inactive (soft delete) rather than hard delete
  const ids = points.map(p => p.id);
  await updatePointPayload(ids, { active: false, expired_at: new Date().toISOString() });
  console.log(`[consolidation] Expired ${ids.length} old events (>${EVENT_TTL_DAYS} days, never accessed, medium/low importance)`);
  return ids.length;
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
