// Collection registry — manages multiple Qdrant collections.
// Default collection: 'shared_memories' (backward compatible).
// Additional collections: brain_<slug> format.

import { getEmbeddingDimensions } from './embedders/interface.js';

const DEFAULT_COLLECTION = 'shared_memories';
const COLLECTION_PREFIX = 'brain_';
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,60}[a-z0-9]$/;

// In-memory registry of known collections (populated on init)
const registry = new Map(); // name → { created_at, description }

/**
 * Get the Qdrant collection name for a given collection slug.
 * Returns the default collection if no slug is provided.
 */
export function resolveCollection(collectionParam) {
  if (!collectionParam || collectionParam === 'default' || collectionParam === DEFAULT_COLLECTION) {
    return DEFAULT_COLLECTION;
  }
  // If already prefixed, use as-is
  if (collectionParam.startsWith(COLLECTION_PREFIX)) {
    return collectionParam;
  }
  return COLLECTION_PREFIX + collectionParam;
}

/**
 * Get the default collection name.
 */
export function getDefaultCollection() {
  return DEFAULT_COLLECTION;
}

/**
 * Validate a collection slug.
 */
export function validateCollectionSlug(slug) {
  if (!slug || typeof slug !== 'string') return 'Collection slug is required';
  if (slug === DEFAULT_COLLECTION || slug === 'default') return 'Cannot use reserved collection name';
  const clean = slug.startsWith(COLLECTION_PREFIX) ? slug.slice(COLLECTION_PREFIX.length) : slug;
  if (!SLUG_PATTERN.test(clean)) {
    return 'Collection slug must be 2-62 chars, lowercase alphanumeric with hyphens/underscores, start/end with alphanumeric';
  }
  return null;
}

/**
 * Register a collection in the in-memory registry.
 */
export function registerCollection(name, metadata = {}) {
  registry.set(name, { created_at: new Date().toISOString(), ...metadata });
}

/**
 * List all known collections.
 */
export function listCollections() {
  return [
    { name: DEFAULT_COLLECTION, description: 'Default shared memory collection', is_default: true },
    ...Array.from(registry.entries()).map(([name, meta]) => ({ name, ...meta, is_default: false })),
  ];
}

/**
 * Check if a collection exists in the registry.
 */
export function isKnownCollection(name) {
  return name === DEFAULT_COLLECTION || registry.has(name);
}

/**
 * Remove a collection from the registry.
 */
export function unregisterCollection(name) {
  registry.delete(name);
}

/**
 * Get the Qdrant collection creation config (shared across all collections).
 */
export function getCollectionConfig() {
  return {
    vectors: {
      size: getEmbeddingDimensions(),
      distance: 'Cosine',
    },
    optimizers_config: {
      indexing_threshold: 100,
    },
  };
}

/**
 * Get the standard payload indexes to create on new collections.
 */
export function getCollectionIndexes() {
  return [
    { field_name: 'type', field_schema: 'Keyword' },
    { field_name: 'source_agent', field_schema: 'Keyword' },
    { field_name: 'client_id', field_schema: 'Keyword' },
    { field_name: 'category', field_schema: 'Keyword' },
    { field_name: 'importance', field_schema: 'Keyword' },
    { field_name: 'content_hash', field_schema: 'Keyword' },
    { field_name: 'key', field_schema: 'Keyword' },
    { field_name: 'subject', field_schema: 'Keyword' },
    { field_name: 'knowledge_category', field_schema: 'Keyword' },
    { field_name: 'active', field_schema: 'Bool' },
    { field_name: 'confidence', field_schema: 'Float' },
    { field_name: 'access_count', field_schema: 'Integer' },
    { field_name: 'created_at', field_schema: { type: 'datetime', is_tenant: false } },
    { field_name: 'last_accessed_at', field_schema: { type: 'datetime', is_tenant: false } },
    { field_name: 'entities[].name', field_schema: 'keyword' },
  ];
}
