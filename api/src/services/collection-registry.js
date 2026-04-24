// Collection registry — manages named memory collections on top of the vector
// store. Default collection: 'shared_memories' (backward compatible).
// Additional collections: 'brain_<slug>' format.

const DEFAULT_COLLECTION = 'shared_memories';
const COLLECTION_PREFIX = 'brain_';
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,60}[a-z0-9]$/;

// name → { created_at, description, ... }
const registry = new Map();

export function resolveCollection(collectionParam) {
  if (!collectionParam || collectionParam === 'default' || collectionParam === DEFAULT_COLLECTION) {
    return DEFAULT_COLLECTION;
  }
  if (collectionParam.startsWith(COLLECTION_PREFIX)) {
    return collectionParam;
  }
  return COLLECTION_PREFIX + collectionParam;
}

export function getDefaultCollection() {
  return DEFAULT_COLLECTION;
}

export function validateCollectionSlug(slug) {
  if (!slug || typeof slug !== 'string') return 'Collection slug is required';
  if (slug === DEFAULT_COLLECTION || slug === 'default') return 'Cannot use reserved collection name';
  const clean = slug.startsWith(COLLECTION_PREFIX) ? slug.slice(COLLECTION_PREFIX.length) : slug;
  if (!SLUG_PATTERN.test(clean)) {
    return 'Collection slug must be 2-62 chars, lowercase alphanumeric with hyphens/underscores, start/end with alphanumeric';
  }
  return null;
}

export function registerCollection(name, metadata = {}) {
  registry.set(name, { created_at: new Date().toISOString(), ...metadata });
}

export function listCollections() {
  return [
    { name: DEFAULT_COLLECTION, description: 'Default shared memory collection', is_default: true },
    ...Array.from(registry.entries()).map(([name, meta]) => ({ name, ...meta, is_default: false })),
  ];
}

export function unregisterCollection(name) {
  registry.delete(name);
}
