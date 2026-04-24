// Structured-store interface. Postgres is the only supported backend; the
// module still exists as a dispatcher so a future backend can be added without
// touching callers.

const BACKEND = process.env.STRUCTURED_STORE || 'postgres';

let store = null;

export async function initStore() {
  if (BACKEND !== 'postgres') {
    throw new Error(`Unsupported STRUCTURED_STORE: ${BACKEND}. Only 'postgres' is supported.`);
  }
  const { PostgresStore } = await import('./postgres.js');
  store = new PostgresStore();
  await store.init();
  console.log('[store] Structured storage: postgres');
}

function requireStore() {
  if (!store) throw new Error('Structured storage not initialized. Call initStore() first.');
  return store;
}

export async function createEvent(data) { return requireStore().createEvent(data); }
export async function listEvents(filters) { return requireStore().listEvents(filters); }
export async function upsertFact(data) { return requireStore().upsertFact(data); }
export async function listFacts(filters) { return requireStore().listFacts(filters); }
export async function upsertStatus(data) { return requireStore().upsertStatus(data); }
export async function listStatuses(filters) { return requireStore().listStatuses(filters); }

export function isStoreAvailable() { return store !== null; }
export function isEntityStoreAvailable() { return store !== null; }

export async function createEntity(data) { return requireStore().createEntity(data); }
export async function findEntity(name) { return requireStore().findEntity(name); }
export async function linkEntityToMemory(entityId, memoryId, role) { return requireStore().linkEntityToMemory(entityId, memoryId, role); }
export async function listEntities(filters) { return requireStore().listEntities(filters); }
export async function getEntityMemories(entityId, limit) { return requireStore().getEntityMemories(entityId, limit); }
export async function upsertAlias(entityId, alias) { return requireStore().upsertAlias(entityId, alias); }
export async function loadAllAliases() { return requireStore().loadAllAliases(); }
export async function getEntityStats() { return requireStore().getEntityStats(); }
export async function createRelationship(sourceId, targetId, type) { return requireStore().createRelationship(sourceId, targetId, type); }

// Direct handle for modules that need to bind the underlying Postgres pool
// (keyword-search FTS initialization).
export function _getStoreInstance() { return store; }
export function getBackendType() { return BACKEND; }
