// Storage backend interface
// Each backend must implement: createEvent, listEvents, upsertFact, listFacts, upsertStatus, listStatuses, healthCheck

const BACKEND = process.env.STRUCTURED_STORE || 'sqlite';

let store = null;

export async function initStore() {
  switch (BACKEND) {
    case 'sqlite': {
      const { SQLiteStore } = await import('./sqlite.js');
      store = new SQLiteStore();
      await store.init();
      break;
    }
    case 'postgres': {
      const { PostgresStore } = await import('./postgres.js');
      store = new PostgresStore();
      await store.init();
      break;
    }
    case 'baserow': {
      const { BaserowStore } = await import('./baserow.js');
      store = new BaserowStore();
      break;
    }
    case 'none':
      store = null;
      console.log('[store] Running without structured storage (Qdrant only)');
      return;
    default:
      throw new Error(`Unknown storage backend: ${BACKEND}. Use: sqlite, postgres, baserow, none`);
  }
  console.log(`[store] Structured storage: ${BACKEND}`);
}

function requireStore() {
  if (!store) {
    throw new Error('Structured storage not configured. Set STRUCTURED_STORE in .env (sqlite, postgres, or baserow).');
  }
  return store;
}

export async function createEvent(data) {
  return requireStore().createEvent(data);
}

export async function listEvents(filters) {
  return requireStore().listEvents(filters);
}

export async function upsertFact(data) {
  return requireStore().upsertFact(data);
}

export async function listFacts(filters) {
  return requireStore().listFacts(filters);
}

export async function upsertStatus(data) {
  return requireStore().upsertStatus(data);
}

export async function listStatuses(filters) {
  return requireStore().listStatuses(filters);
}

export function isStoreAvailable() {
  return store !== null;
}

export function getStoreInfo() {
  return {
    backend: BACKEND,
    available: store !== null,
  };
}

// Entity store — available for sqlite/postgres, no-ops for baserow/none
export function isEntityStoreAvailable() {
  return store !== null && (BACKEND === 'sqlite' || BACKEND === 'postgres');
}

export async function createEntity(data) {
  return requireStore().createEntity(data);
}

export async function findEntity(name) {
  return requireStore().findEntity(name);
}

export async function linkEntityToMemory(entityId, memoryId, role) {
  return requireStore().linkEntityToMemory(entityId, memoryId, role);
}

export async function listEntities(filters) {
  return requireStore().listEntities(filters);
}

export async function getEntityMemories(entityId, limit) {
  return requireStore().getEntityMemories(entityId, limit);
}

export async function upsertAlias(entityId, alias) {
  return requireStore().upsertAlias(entityId, alias);
}

export async function loadAllAliases() {
  return requireStore().loadAllAliases();
}

export async function getEntityStats() {
  return requireStore().getEntityStats();
}

export async function createRelationship(sourceId, targetId, type) {
  return requireStore().createRelationship(sourceId, targetId, type);
}

export async function getRelationships(entityId, minStrength) {
  return requireStore().getRelationships(entityId, minStrength);
}

export async function listRelationships(filters) {
  return requireStore().listRelationships(filters);
}
