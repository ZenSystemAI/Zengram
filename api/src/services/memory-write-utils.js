import crypto from 'crypto';
import { scrubCredentials } from './scrub.js';
import { validateMemoryInput } from '../middleware/validate.js';

export function buildDedupExtraFilter(clientId, type) {
  return {
    active: true,
    client_id: clientId || 'global',
    type,
  };
}

export function normalizeMemoryRecord(record = {}, options = {}) {
  const {
    defaultType,
    defaultSourceAgent,
  } = options;

  const rawContent = record.content || record.text || '';
  const normalized = {
    ...record,
    type: record.type || defaultType,
    content: scrubCredentials(rawContent),
    source_agent: record.source_agent || defaultSourceAgent,
    client_id: record.client_id || 'global',
    category: record.category || 'episodic',
    importance: record.importance || 'medium',
    knowledge_category: record.knowledge_category || 'general',
  };

  const validationError = validateMemoryInput({
    type: normalized.type,
    content: normalized.content,
    source_agent: normalized.source_agent,
    importance: normalized.importance,
    client_id: normalized.client_id,
    key: normalized.key,
    subject: normalized.subject,
    status_value: normalized.status_value,
  });

  if (validationError) {
    return { error: validationError };
  }

  return {
    normalized,
    contentHash: crypto.createHash('sha256').update(normalized.content).digest('hex').slice(0, 16),
  };
}

export function normalizeImportRecord(record = {}) {
  return normalizeMemoryRecord(record, {
    defaultType: 'event',
    defaultSourceAgent: 'import',
  });
}
