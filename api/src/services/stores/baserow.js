import fetchWithTimeout from '../fetch-with-timeout.js';

// Baserow storage backend — extracted from original baserow.js

const BASEROW_URL = process.env.BASEROW_URL || 'http://localhost:8082';
const BASEROW_API_KEY = process.env.BASEROW_API_KEY;
const EVENTS_TABLE = process.env.BASEROW_EVENTS_TABLE_ID;
const FACTS_TABLE = process.env.BASEROW_FACTS_TABLE_ID;
const STATUS_TABLE = process.env.BASEROW_STATUS_TABLE_ID;

async function baserowRequest(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Token ${BASEROW_API_KEY}`,
  };

  const res = await fetchWithTimeout(`${BASEROW_URL}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  }, 15000);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Baserow ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

function stripEmpty(obj) {
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== '' && v !== null && v !== undefined) clean[k] = v;
  }
  return clean;
}

export class BaserowStore {
  async createEvent(data) {
    if (!EVENTS_TABLE) throw new Error('BASEROW_EVENTS_TABLE_ID not configured');
    return baserowRequest(`/api/database/rows/table/${EVENTS_TABLE}/?user_field_names=true`, {
      method: 'POST',
      body: JSON.stringify(stripEmpty(data)),
    });
  }

  async listEvents(filters = {}) {
    if (!EVENTS_TABLE) throw new Error('BASEROW_EVENTS_TABLE_ID not configured');
    const params = new URLSearchParams({ user_field_names: 'true', size: '50', order_by: '-created_at' });
    if (filters.source_agent) params.append('filter__source_agent__equal', filters.source_agent);
    if (filters.category) params.append('filter__category__equal', filters.category);
    if (filters.since) params.append('filter__created_at__date_after', filters.since);
    return baserowRequest(`/api/database/rows/table/${EVENTS_TABLE}/?${params}`);
  }

  async upsertFact(data) {
    if (!FACTS_TABLE) throw new Error('BASEROW_FACTS_TABLE_ID not configured');
    const params = new URLSearchParams({ user_field_names: 'true', filter__key__equal: data.key });
    const existing = await baserowRequest(`/api/database/rows/table/${FACTS_TABLE}/?${params}`);

    if (existing.results && existing.results.length > 0) {
      const row = existing.results[0];
      return baserowRequest(`/api/database/rows/table/${FACTS_TABLE}/${row.id}/?user_field_names=true`, {
        method: 'PATCH',
        body: JSON.stringify(stripEmpty({ ...data, updated_at: new Date().toISOString() })),
      });
    }

    return baserowRequest(`/api/database/rows/table/${FACTS_TABLE}/?user_field_names=true`, {
      method: 'POST',
      body: JSON.stringify(stripEmpty({ ...data, updated_at: new Date().toISOString() })),
    });
  }

  async listFacts(filters = {}) {
    if (!FACTS_TABLE) throw new Error('BASEROW_FACTS_TABLE_ID not configured');
    const params = new URLSearchParams({ user_field_names: 'true', size: '50' });
    if (filters.source_agent) params.append('filter__source_agent__equal', filters.source_agent);
    if (filters.category) params.append('filter__category__equal', filters.category);
    if (filters.client_id) params.append('filter__client_id__equal', filters.client_id);
    if (filters.key) params.append('filter__key__contains', filters.key);
    return baserowRequest(`/api/database/rows/table/${FACTS_TABLE}/?${params}`);
  }

  async upsertStatus(data) {
    if (!STATUS_TABLE) throw new Error('BASEROW_STATUS_TABLE_ID not configured');
    const params = new URLSearchParams({ user_field_names: 'true', filter__subject__equal: data.subject });
    const existing = await baserowRequest(`/api/database/rows/table/${STATUS_TABLE}/?${params}`);

    if (existing.results && existing.results.length > 0) {
      const row = existing.results[0];
      return baserowRequest(`/api/database/rows/table/${STATUS_TABLE}/${row.id}/?user_field_names=true`, {
        method: 'PATCH',
        body: JSON.stringify(stripEmpty({ ...data, updated_at: new Date().toISOString() })),
      });
    }

    return baserowRequest(`/api/database/rows/table/${STATUS_TABLE}/?user_field_names=true`, {
      method: 'POST',
      body: JSON.stringify(stripEmpty({ ...data, updated_at: new Date().toISOString() })),
    });
  }

  async listStatuses(filters = {}) {
    if (!STATUS_TABLE) throw new Error('BASEROW_STATUS_TABLE_ID not configured');
    const params = new URLSearchParams({ user_field_names: 'true', size: '50' });
    if (filters.source_agent) params.append('filter__source_agent__equal', filters.source_agent);
    if (filters.category) params.append('filter__category__equal', filters.category);
    if (filters.subject) params.append('filter__subject__contains', filters.subject);
    return baserowRequest(`/api/database/rows/table/${STATUS_TABLE}/?${params}`);
  }

  // Entity methods — no-ops for Baserow (entity data comes from Qdrant payload only)
  async createEntity() { return { id: null, created: false }; }
  async findEntity() { return null; }
  async linkEntityToMemory() { return { linked: false }; }
  async listEntities() { return { results: [] }; }
  async getEntityMemories() { return { results: [] }; }
  async upsertAlias() { return { created: false }; }
  async loadAllAliases() { return []; }
  async getEntityStats() { return { total: 0, by_type: {}, top_mentioned: [] }; }

  // Graph/relationship methods — no-ops for Baserow
  async createRelationship() { return { id: null, strength: 0 }; }
  async getRelationships() { return []; }
  async listRelationships() { return []; }
}
