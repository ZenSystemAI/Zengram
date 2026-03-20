import { Router } from 'express';
import crypto from 'crypto';
import { embed } from '../services/embedders/interface.js';
import { upsertPoint, findByPayload, updatePointPayload } from '../services/qdrant.js';
import { createEvent, upsertStatus, isStoreAvailable, isEntityStoreAvailable, createEntity, findEntity, linkEntityToMemory } from '../services/stores/interface.js';
import { scrubCredentials } from '../services/scrub.js';
import { extractEntities, linkExtractedEntities } from '../services/entities.js';
import { validateClientId, MAX_OBSERVED_BY } from '../middleware/validate.js';

export const webhookRouter = Router();

// POST /webhook/n8n — Auto-log workflow execution results
webhookRouter.post('/n8n', async (req, res) => {
  try {
    const {
      workflow_name,
      workflow_id,
      execution_id,
      status,      // 'success' | 'error'
      message,     // optional description
      client_id,   // optional
      items_processed, // optional count
      error_message,   // optional if status=error
    } = req.body;

    if (!workflow_name || !status) {
      return res.status(400).json({
        error: 'Missing required fields: workflow_name, status',
        example: {
          workflow_name: 'seo-rank-update',
          workflow_id: 'abc123',
          execution_id: 'exec_456',
          status: 'success',
          message: 'Updated 42 keywords for acme-corp.com',
          client_id: 'acme-corp',
          items_processed: 42,
        },
      });
    }

    const clientIdError = validateClientId(client_id);
    if (clientIdError) return res.status(400).json({ error: clientIdError });

    const now = new Date().toISOString();

    // Build content string
    let content = `n8n workflow "${workflow_name}" ${status === 'success' ? 'completed successfully' : 'FAILED'}`;
    if (message) content += `: ${message}`;
    if (items_processed) content += ` (${items_processed} items processed)`;
    if (error_message) content += ` — Error: ${error_message}`;
    if (execution_id) content += ` [execution: ${execution_id}]`;

    content = scrubCredentials(content);

    const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

    // Dedup: if identical content already exists, check for corroboration
    const sourceAgent = 'n8n';
    const duplicates = await findByPayload('content_hash', contentHash, { active: true });
    if (duplicates.length > 0) {
      const existing = duplicates[0];
      const existingObservedBy = existing.payload.observed_by || [existing.payload.source_agent];

      if (existingObservedBy.includes(sourceAgent)) {
        return res.status(200).json({
          id: existing.id,
          deduplicated: true,
          observed_by: existingObservedBy,
          observation_count: existingObservedBy.length,
          message: 'Identical webhook event already exists — skipped',
        });
      }

      // Different source → corroborate (with cap)
      if (existingObservedBy.length >= MAX_OBSERVED_BY) {
        return res.status(200).json({
          id: existing.id,
          deduplicated: true,
          observed_by: existingObservedBy,
          observation_count: existingObservedBy.length,
          message: `Observer cap reached (${MAX_OBSERVED_BY}) — corroboration noted but not recorded`,
        });
      }
      const updatedObservedBy = [...existingObservedBy, sourceAgent];
      await updatePointPayload(existing.id, {
        observed_by: updatedObservedBy,
        observation_count: updatedObservedBy.length,
        last_observed_at: new Date().toISOString(),
      });

      return res.status(200).json({
        id: existing.id,
        corroborated: true,
        observed_by: updatedObservedBy,
        observation_count: updatedObservedBy.length,
        message: `Cross-agent corroboration recorded — now observed by ${updatedObservedBy.length} agents`,
      });
    }

    const pointId = crypto.randomUUID();

    // Extract entities
    let extractedEntities = [];
    try {
      extractedEntities = extractEntities(content, client_id || 'global', 'n8n');
      // workflow_name is always an entity
      if (workflow_name) {
        const alreadyHas = extractedEntities.some(e => e.name.toLowerCase() === workflow_name.toLowerCase());
        if (!alreadyHas) extractedEntities.push({ name: workflow_name, type: 'workflow', role: 'subject', entityId: null });
      }
    } catch (e) { /* non-blocking */ }

    const entityPayload = extractedEntities.length > 0 ? extractedEntities.map(e => ({ name: e.name, type: e.type })) : undefined;

    // Store as event in Qdrant
    const vector = await embed(content, 'store');
    await upsertPoint(pointId, vector, {
      text: content,
      type: 'event',
      source_agent: 'n8n',
      observed_by: ['n8n'],
      observation_count: 1,
      client_id: client_id || 'global',
      category: 'episodic',
      importance: status === 'error' ? 'high' : 'medium',
      content_hash: contentHash,
      created_at: now,
      last_accessed_at: now,
      access_count: 0,
      confidence: 1.0,
      active: true,
      consolidated: false,
      supersedes: null,
      superseded_by: null,
      metadata: {
        workflow_name,
        workflow_id: workflow_id || null,
        execution_id: execution_id || null,
        status,
        items_processed: items_processed || null,
      },
      ...(entityPayload ? { entities: entityPayload } : {}),
    });

    // Link entities (non-blocking)
    if (isEntityStoreAvailable() && extractedEntities.length > 0) {
      try {
        await linkExtractedEntities(extractedEntities, pointId, { createEntity, findEntity, linkEntityToMemory });
      } catch (e) { console.error('[webhook:entities] Linking failed:', e.message); }
    }

    // Store as event in structured database
    const warnings = [];
    if (isStoreAvailable()) try {
      await createEvent({
        content,
        type: 'event',
        source_agent: 'n8n',
        client_id: client_id || 'global',
        category: 'episodic',
        importance: status === 'error' ? 'high' : 'medium',
        content_hash: contentHash,
        created_at: now,
      });
    } catch (e) {
      console.error('[webhook:n8n] Store write failed:', e.message);
      warnings.push(`Structured store write failed: ${e.message}`);
    }

    // If workflow errored, also update status
    if (status === 'error') {
      try {
        await upsertStatus({
          subject: workflow_name,
          status: `ERROR: ${error_message || message || 'Unknown error'}`,
          source_agent: 'n8n',
          category: 'episodic',
        });
      } catch (e) {
        console.error('[webhook:n8n] Status update failed:', e.message);
        warnings.push(`Status update failed: ${e.message}`);
      }
    }

    const response = { id: pointId, content };
    if (warnings.length > 0) response.warnings = warnings;
    res.status(201).json(response);
  } catch (err) {
    console.error('[webhook:n8n] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
