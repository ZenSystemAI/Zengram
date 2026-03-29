// Input validation middleware and helpers for memory API

const AGENT_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_TYPES = ['event', 'fact', 'decision', 'status'];
const VALID_IMPORTANCE = ['critical', 'high', 'medium', 'low'];
const MAX_CONTENT_LENGTH = 10_000;
const MAX_METADATA_SIZE = 10_240; // 10 KB serialized
const MAX_METADATA_DEPTH = 3;
const MAX_OBSERVED_BY = 20;
const MAX_STRING_FIELD_LENGTH = 256;

function checkDepth(obj, max, current = 0) {
  if (current >= max) return false;
  if (obj === null || typeof obj !== 'object') return true;
  if (Array.isArray(obj)) {
    return obj.every(item => checkDepth(item, max, current + 1));
  }
  return Object.values(obj).every(val => checkDepth(val, max, current + 1));
}

export function validateSourceAgent(agent) {
  if (!agent || typeof agent !== 'string') return 'source_agent is required and must be a string';
  if (!AGENT_NAME_REGEX.test(agent)) return `source_agent must match ${AGENT_NAME_REGEX} (1-64 alphanumeric, hyphens, underscores)`;
  return null;
}

export function validateType(type) {
  if (!type) return 'type is required';
  if (!VALID_TYPES.includes(type)) return `Invalid type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`;
  return null;
}

export function validateImportance(importance) {
  if (!importance) return null; // optional, defaults to 'medium'
  if (!VALID_IMPORTANCE.includes(importance)) return `Invalid importance: ${importance}. Must be one of: ${VALID_IMPORTANCE.join(', ')}`;
  return null;
}

export function validateContent(content) {
  if (!content || typeof content !== 'string') return 'content is required and must be a string';
  if (content.length > MAX_CONTENT_LENGTH) return `content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters (got ${content.length})`;
  return null;
}

export function validateMetadata(metadata) {
  if (metadata === undefined || metadata === null) return null; // optional
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return 'metadata must be a plain object';
  const serialized = JSON.stringify(metadata);
  if (serialized.length > MAX_METADATA_SIZE) return `metadata exceeds maximum size of ${MAX_METADATA_SIZE} bytes (got ${serialized.length})`;
  if (!checkDepth(metadata, MAX_METADATA_DEPTH)) return `metadata exceeds maximum nesting depth of ${MAX_METADATA_DEPTH}`;
  return null;
}

export function validateStringField(value, name, maxLen = MAX_STRING_FIELD_LENGTH) {
  if (value === undefined || value === null) return null; // optional
  if (typeof value !== 'string') return `${name} must be a string`;
  if (value.length > maxLen) return `${name} exceeds maximum length of ${maxLen} characters`;
  return null;
}

export function validateClientId(clientId) {
  return validateStringField(clientId, 'client_id', 64);
}

export function validateTemporalFields(valid_from, valid_to) {
  if (valid_from !== undefined && valid_from !== null) {
    if (typeof valid_from !== 'string' || isNaN(Date.parse(valid_from))) {
      return 'valid_from must be a valid ISO 8601 timestamp';
    }
  }
  if (valid_to !== undefined && valid_to !== null) {
    if (typeof valid_to !== 'string' || isNaN(Date.parse(valid_to))) {
      return 'valid_to must be a valid ISO 8601 timestamp';
    }
  }
  if (valid_from && valid_to && new Date(valid_from) >= new Date(valid_to)) {
    return 'valid_from must be before valid_to';
  }
  return null;
}

// Validate all inputs for POST /memory and return first error or null
export function validateMemoryInput({ type, content, source_agent, importance, metadata, client_id, key, subject, status_value, valid_from, valid_to }) {
  return validateType(type)
    || validateContent(content)
    || validateSourceAgent(source_agent)
    || validateImportance(importance)
    || validateMetadata(metadata)
    || validateClientId(client_id)
    || validateStringField(key, 'key', 128)
    || validateStringField(subject, 'subject', 256)
    || validateStringField(status_value, 'status_value', 256)
    || validateTemporalFields(valid_from, valid_to)
    || null;
}

export { MAX_OBSERVED_BY, VALID_TYPES, VALID_IMPORTANCE };
