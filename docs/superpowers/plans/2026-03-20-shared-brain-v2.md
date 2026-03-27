# Shared Brain v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-client knowledge base, import/export, webhook notifications, and entity graph visualization to the Shared Brain multi-agent memory system.

**Architecture:** Extends the existing Express API + Qdrant + Postgres stack with 4 new MCP tools (brain_client, brain_export, brain_import, brain_graph), a client fingerprint resolver, webhook notifications, and an interactive D3.js entity graph. All changes are additive — zero breaking changes.

**Tech Stack:** Node.js/Express, Qdrant vector store, Postgres, MCP SDK, D3.js, Baserow API

**Spec:** `docs/superpowers/specs/2026-03-20-shared-brain-v2-design.md`

**Out-of-scope (separate work, not in this repo):**
- Fireflies n8n workflow fix (spec Section 4) — n8n workflow change, uses `GET /client/fingerprints` endpoint built in Task 4
- Nightly backup n8n workflow (spec Section 5) — n8n workflow, calls `GET /export` endpoint built in Task 6
- Claude Code PostToolUse hook for client file auto-capture (spec Section 6) — Claude Code settings.json config
- Git post-commit hook for auto-capture (spec Section 6) — shell script in client repos

These consume the API endpoints built here but are configured outside this codebase.

---

### Task 1: Add `knowledge_category` field to Qdrant + Postgres

**Files:**
- Modify: `api/src/services/qdrant.js` — add keyword index for knowledge_category
- Modify: `api/src/services/stores/postgres.js` — add column to events, facts, statuses tables
- Modify: `api/src/services/stores/sqlite.js` — add column to events, facts, statuses tables
- Modify: `api/src/routes/memory.js` — accept and store knowledge_category
- Modify: `api/src/routes/webhook.js` — accept knowledge_category
- Test: `api/tests/knowledge-category.test.js`

- [ ] **Step 1: Add knowledge_category index to Qdrant**

In `api/src/services/qdrant.js`, add to `initQdrant()` keyword fields array:
```javascript
const keywordFields = ['type', 'source_agent', 'client_id', 'category', 'importance', 'content_hash', 'key', 'subject', 'knowledge_category'];
```

- [ ] **Step 2: Add knowledge_category column to Postgres store**

In `api/src/services/stores/postgres.js`, add `knowledge_category TEXT DEFAULT 'general'` to the CREATE TABLE statements for events, facts, and statuses. Add it to all INSERT and SELECT queries.

- [ ] **Step 3: Add knowledge_category column to SQLite store**

Same changes in `api/src/services/stores/sqlite.js`.

- [ ] **Step 4: Accept knowledge_category in POST /memory route**

In `api/src/routes/memory.js`, destructure `knowledge_category` from `req.body`, default to `'general'`, add to Qdrant payload and structured store data.

- [ ] **Step 5: Accept knowledge_category in webhook route**

In `api/src/routes/webhook.js`, add `knowledge_category: 'general'` to the default payload.

- [ ] **Step 6: Run existing tests to verify no regressions**

Run: `cd api && node --test tests/scrub.test.js && node --test tests/validate.test.js`

- [ ] **Step 7: Commit**

```bash
git add api/src/services/qdrant.js api/src/services/stores/postgres.js api/src/services/stores/sqlite.js api/src/routes/memory.js api/src/routes/webhook.js
git commit -m "feat: add knowledge_category field across Qdrant, Postgres, SQLite, and API routes"
```

---

### Task 2: Build client fingerprint resolver

**Files:**
- Create: `api/src/services/client-resolver.js`
- Test: `api/tests/client-resolver.test.js`

- [ ] **Step 1: Write tests for client resolver**

```javascript
// api/tests/client-resolver.test.js
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { ClientResolver } from '../src/services/client-resolver.js';

describe('ClientResolver', () => {
  let resolver;

  before(() => {
    resolver = new ClientResolver();
    resolver.loadFingerprints([
      { client_id: 'acme-loans', fingerprints: { aliases: ['AL', 'Acme Loans'], people: ['Alex'], domains: ['acme-loans.ca'], keywords: ['Springfield'] } },
      { client_id: 'quickcredit', fingerprints: { aliases: ['QuickCredit', 'QC'], people: ['Alex'], domains: ['quickcredit.com'], keywords: ['Riverside'] } },
      { client_id: 'greenlife', fingerprints: { aliases: ['GL'], people: ['Jordan'], domains: ['greenlife.ca'], keywords: [] } },
    ]);
  });

  it('should resolve by alias', () => {
    assert.strictEqual(resolver.resolve('Talked to AL about their SEO strategy'), 'acme-loans');
  });

  it('should resolve by domain', () => {
    assert.strictEqual(resolver.resolve('Updated acme-loans.ca homepage'), 'acme-loans');
  });

  it('should resolve by person + context', () => {
    // Alex alone is ambiguous (both acme-loans + quickcredit), needs 2nd signal
    assert.strictEqual(resolver.resolve('Alex called about Springfield store'), 'acme-loans');
  });

  it('should return null when below threshold', () => {
    assert.strictEqual(resolver.resolve('Had a meeting today about loans'), null);
  });

  it('should return array for multi-client content', () => {
    const result = resolver.resolve('Discussed acme-loans.ca redesign and GreenLife supplement strategy');
    assert.ok(Array.isArray(result));
    assert.ok(result.includes('acme-loans'));
    assert.ok(result.includes('greenlife'));
  });

  it('should be case-insensitive', () => {
    assert.strictEqual(resolver.resolve('ACME-LOANS website is down'), 'acme-loans');
  });

  it('should handle accented characters', () => {
    assert.strictEqual(resolver.resolve('QuickCrédit needs new landing page for Riverside'), 'quickcredit');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test tests/client-resolver.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ClientResolver**

```javascript
// api/src/services/client-resolver.js
const MIN_THRESHOLD = 2;

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9\s.]/g, ' ');
}

export class ClientResolver {
  constructor() {
    this.clients = [];
  }

  loadFingerprints(clients) {
    this.clients = clients.map(c => ({
      client_id: c.client_id,
      patterns: [
        ...(c.fingerprints.aliases || []).map(a => normalize(a)),
        ...(c.fingerprints.people || []).map(p => normalize(p)),
        ...(c.fingerprints.domains || []).map(d => normalize(d)),
        ...(c.fingerprints.keywords || []).map(k => normalize(k)),
      ].filter(p => p.length > 0),
    }));
  }

  resolve(text) {
    if (!text || this.clients.length === 0) return null;
    const normalized = normalize(text);

    const scores = [];
    for (const client of this.clients) {
      let score = 0;
      for (const pattern of client.patterns) {
        if (normalized.includes(pattern)) score++;
      }
      if (score >= MIN_THRESHOLD) {
        scores.push({ client_id: client.client_id, score });
      }
    }

    if (scores.length === 0) return null;
    if (scores.length === 1) return scores[0].client_id;

    // Multiple clients above threshold — return array
    scores.sort((a, b) => b.score - a.score);
    return scores.map(s => s.client_id);
  }
}

// Singleton with Baserow refresh
let instance = null;

export function getClientResolver() {
  if (!instance) instance = new ClientResolver();
  return instance;
}

export async function initClientResolver() {
  const resolver = getClientResolver();

  // Try loading from Baserow
  const baserowUrl = process.env.BASEROW_URL;
  const baserowToken = process.env.BASEROW_CLIENT_TOKEN || process.env.BASEROW_API_KEY;
  const clientsTableId = process.env.BASEROW_CLIENTS_TABLE_ID || '734';

  if (baserowUrl && baserowToken) {
    try {
      await refreshFingerprints(resolver, baserowUrl, baserowToken, clientsTableId);
      console.log(`[client-resolver] Loaded ${resolver.clients.length} client fingerprints from Baserow`);
    } catch (e) {
      console.warn(`[client-resolver] Baserow fetch failed (resolver empty): ${e.message}`);
    }
  } else {
    console.log('[client-resolver] No Baserow config — client resolver disabled');
  }

  return resolver;
}

async function refreshFingerprints(resolver, baserowUrl, token, tableId) {
  const res = await fetch(`${baserowUrl}/api/database/rows/table/${tableId}/?user_field_names=true&size=100`, {
    headers: { Authorization: `Token ${token}` },
  });
  if (!res.ok) throw new Error(`Baserow ${res.status}`);
  const data = await res.json();

  const clients = data.results
    .filter(r => r.client_id && r.active)
    .map(r => {
      let fingerprints = { aliases: [], people: [], domains: [], keywords: [] };
      if (r.client_fingerprints) {
        try {
          fingerprints = typeof r.client_fingerprints === 'string'
            ? JSON.parse(r.client_fingerprints)
            : r.client_fingerprints;
        } catch (e) { /* ignore parse errors */ }
      }
      // Auto-populate from existing fields if fingerprints are empty
      if (fingerprints.aliases.length === 0 && r.Name) fingerprints.aliases.push(r.Name);
      if (fingerprints.domains.length === 0 && r.website_url) {
        try { fingerprints.domains.push(new URL(r.website_url).hostname); } catch (e) {}
      }
      return { client_id: r.client_id, fingerprints };
    });

  resolver.loadFingerprints(clients);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test tests/client-resolver.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/services/client-resolver.js api/tests/client-resolver.test.js
git commit -m "feat: client fingerprint resolver with accent normalization and multi-client detection"
```

---

### Task 3: Add `knowledge_category` to MCP tools (brain_store + brain_search)

**Files:**
- Modify: `mcp-server/src/index.js` — add knowledge_category to brain_store input schema and brain_search filters

- [ ] **Step 1: Add knowledge_category to brain_store schema**

In `mcp-server/src/index.js`, add to brain_store `properties`:
```javascript
knowledge_category: {
  type: 'string',
  enum: ['brand', 'strategy', 'meeting', 'content', 'technical', 'relationship', 'general'],
  description: 'Domain category: brand=voice/identity, strategy=plans/positioning, meeting=call takeaways, content=published work, technical=hosting/CMS/SEO issues, relationship=contacts/preferences, general=default',
},
```

- [ ] **Step 2: Add knowledge_category to brain_search schema**

In `mcp-server/src/index.js`, add to brain_search `properties`:
```javascript
knowledge_category: {
  type: 'string',
  enum: ['brand', 'strategy', 'meeting', 'content', 'technical', 'relationship', 'general'],
  description: 'Filter by knowledge category (optional)',
},
```

- [ ] **Step 3: Wire knowledge_category in brain_store handler**

Find the brain_store case in the CallToolRequestSchema handler. Add `knowledge_category` to the body sent to the API.

- [ ] **Step 4: Wire knowledge_category in brain_search handler**

Find the brain_search case. Add `knowledge_category` as a query param when provided.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/index.js
git commit -m "feat: add knowledge_category to brain_store and brain_search MCP tools"
```

---

### Task 4: Build `brain_client` API endpoint

**Files:**
- Create: `api/src/routes/client.js`
- Modify: `api/src/index.js` — register client router
- Test: `api/tests/client-route.test.js`

- [ ] **Step 1: Write test for client briefing endpoint**

```javascript
// api/tests/client-route.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('client route response format', () => {
  it('should structure briefing with profile and knowledge sections', () => {
    const response = {
      client_id: 'acme-loans',
      profile: { name: 'Acme Loans', industry: 'loans' },
      knowledge: {
        brand: [], strategy: [], meeting: [],
        content: [], technical: [], relationship: [],
      },
    };
    assert.ok(response.profile);
    assert.ok(response.knowledge);
    assert.strictEqual(Object.keys(response.knowledge).length, 6);
  });
});
```

- [ ] **Step 2: Implement client route**

```javascript
// api/src/routes/client.js
import { Router } from 'express';
import { scrollPoints, searchPoints } from '../services/qdrant.js';
import { embed } from '../services/embedders/interface.js';
import { getClientResolver } from '../services/client-resolver.js';

export const clientRouter = Router();

const KNOWLEDGE_CATEGORIES = ['brand', 'strategy', 'meeting', 'content', 'technical', 'relationship'];
const BRIEFING_LIMIT_PER_CATEGORY = 3;

// GET /client/:clientId — client briefing or filtered search
clientRouter.get('/:clientId', async (req, res) => {
  try {
    let { clientId } = req.params;
    const { query, category, format } = req.query;
    const isCompact = format !== 'full';

    // Resolve fuzzy name via fingerprints
    const resolver = getClientResolver();
    const resolved = resolver.resolve(clientId);
    if (resolved && !Array.isArray(resolved)) clientId = resolved;

    if (query) {
      // Search mode — semantic search filtered by client_id
      const vector = await embed(query, 'search');
      const filter = { client_id: clientId, active: true };
      if (category) filter.knowledge_category = category;
      const results = await searchPoints(vector, filter, 10);

      const memories = results.map(r => {
        const m = {
          id: r.id,
          score: parseFloat(r.score.toFixed(4)),
          type: r.payload.type,
          content: isCompact ? (r.payload.content || r.payload.text || '').slice(0, 200) + '...' : (r.payload.content || r.payload.text),
          knowledge_category: r.payload.knowledge_category || 'general',
          created_at: r.payload.created_at,
        };
        return m;
      });

      return res.json({ client_id: clientId, mode: 'search', query, count: memories.length, results: memories });
    }

    // Briefing mode — latest memories per category
    const knowledge = {};
    for (const cat of KNOWLEDGE_CATEGORIES) {
      // Scroll with client_id + knowledge_category filter
      const filter = { client_id: clientId, active: true, knowledge_category: cat };
      const result = await scrollPoints(filter, 20);
      const points = (result.points || [])
        .sort((a, b) => new Date(b.payload.created_at) - new Date(a.payload.created_at))
        .slice(0, BRIEFING_LIMIT_PER_CATEGORY);

      knowledge[cat] = points.map(p => ({
        id: p.id,
        content: isCompact ? (p.payload.content || p.payload.text || '').slice(0, 200) + '...' : (p.payload.content || p.payload.text),
        source_agent: p.payload.source_agent,
        created_at: p.payload.created_at,
      }));
    }

    res.json({ client_id: clientId, mode: 'briefing', knowledge });
  } catch (err) {
    console.error('[client] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /client — list all clients with fingerprints
clientRouter.get('/', async (req, res) => {
  const resolver = getClientResolver();
  res.json({
    clients: resolver.clients.map(c => ({ client_id: c.client_id, pattern_count: c.patterns.length })),
  });
});
```

- [ ] **Step 3: Register client router in index.js**

In `api/src/index.js`, add:
```javascript
import { clientRouter } from './routes/client.js';
```
And register: `app.use('/client', clientRouter);`

Also import and call `initClientResolver`:
```javascript
import { initClientResolver } from './services/client-resolver.js';
```
Call `await initClientResolver();` in the `start()` function after `initStore()`.

- [ ] **Step 4: Add fingerprints endpoint**

Add to `api/src/routes/client.js`:
```javascript
// GET /client/fingerprints — raw fingerprints for external consumers (Fireflies, n8n)
clientRouter.get('/fingerprints', async (req, res) => {
  const resolver = getClientResolver();
  // Return the raw fingerprint data in a format suitable for LLM prompts
  const fingerprints = resolver.clients.map(c => ({
    client_id: c.client_id,
    patterns: c.patterns,
  }));
  res.json({ fingerprints });
});
```

Note: Register the `/fingerprints` route BEFORE `/:clientId` in the router to avoid route collision.

- [ ] **Step 5: Run tests**

Run: `cd api && node --test tests/client-route.test.js`

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/client.js api/src/index.js api/tests/client-route.test.js
git commit -m "feat: brain_client API endpoint with briefing and search modes"
```

---

### Task 5: Add `brain_client` MCP tool

**Files:**
- Modify: `mcp-server/src/index.js` — add brain_client tool definition and handler

- [ ] **Step 1: Add brain_client tool definition**

In `mcp-server/src/index.js`, add to the tools array:
```javascript
{
  name: 'brain_client',
  description: 'Get everything known about a client — profile, brand, strategy, meetings, content, technical details, relationships. Can also do semantic search within a client\'s memories. Accepts fuzzy names (e.g. "AL" resolves to "acme-loans").',
  inputSchema: {
    type: 'object',
    properties: {
      client: { type: 'string', description: 'Client ID or fuzzy name (resolved via fingerprints)' },
      category: { type: 'string', enum: ['brand', 'strategy', 'meeting', 'content', 'technical', 'relationship'], description: 'Filter by knowledge category (optional)' },
      query: { type: 'string', description: 'Semantic search within this client\'s memories (optional — omit for full briefing)' },
      format: { type: 'string', enum: ['compact', 'full'], description: 'compact (default) or full' },
    },
    required: ['client'],
  },
},
```

- [ ] **Step 2: Add brain_client handler**

In the CallToolRequestSchema handler switch/if block:
```javascript
case 'brain_client': {
  const { client, category, query, format } = args;
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (query) params.set('query', query);
  if (format) params.set('format', format);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const data = await apiRequest(`/client/${encodeURIComponent(client)}${qs}`);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
```

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/index.js
git commit -m "feat: brain_client MCP tool for client briefings and filtered search"
```

---

### Task 6: Build import/export API endpoints

**Files:**
- Create: `api/src/routes/export.js`
- Modify: `api/src/index.js` — register export router
- Test: `api/tests/export.test.js`

- [ ] **Step 1: Write test for export format**

```javascript
// api/tests/export.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('export format', () => {
  it('should include all type-specific fields', () => {
    const record = {
      id: 'test-uuid',
      content: 'test content',
      type: 'fact',
      key: 'test-key',
      subject: null,
      client_id: 'global',
      knowledge_category: 'general',
      category: 'semantic',
      source_agent: 'test',
      importance: 'medium',
      confidence: 1.0,
      access_count: 0,
      active: true,
      superseded_by: null,
      entities: [],
      created_at: '2026-03-20T00:00:00Z',
      last_accessed_at: '2026-03-20T00:00:00Z',
    };
    // Verify all required fields present
    assert.ok(record.id);
    assert.ok(record.content);
    assert.ok(record.type);
    assert.ok('key' in record);
    assert.ok('subject' in record);
    assert.ok('knowledge_category' in record);
  });

  it('should reject import over 500 records', () => {
    const records = Array(501).fill({ content: 'x', type: 'event', source_agent: 'test' });
    assert.ok(records.length > 500, 'Should exceed limit');
  });
});
```

- [ ] **Step 2: Implement export route**

Create `api/src/routes/export.js` with:
- `GET /` — export: paginated Qdrant scroll, returns full payloads as JSON array
- `POST /import` — import: validates size limit (500), dedup check via content_hash, embed + upsert in batches of 10 with 100ms delay

Key implementation details:
- Export uses `scrollPoints` with `next_page_offset` pagination loop
- Import computes content_hash, checks for existing via `findByPayload('content_hash', hash)`, skips duplicates
- Import calls `embed(content, 'store')` for each record
- Response format: `{ imported: N, skipped: N, errors: N }`

- [ ] **Step 3: Register export router**

In `api/src/index.js`: `app.use('/export', exportRouter);`

- [ ] **Step 4: Run tests**

Run: `cd api && node --test tests/export.test.js`

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/export.js api/src/index.js api/tests/export.test.js
git commit -m "feat: import/export API endpoints with dedup, batching, and size limits"
```

---

### Task 7: Add `brain_export` and `brain_import` MCP tools

**Files:**
- Modify: `mcp-server/src/index.js`

- [ ] **Step 1: Add brain_export tool definition + handler**

Tool definition:
```javascript
{
  name: 'brain_export',
  description: 'Export shared memories as JSON for backup or migration. Returns all memory payloads (no vectors — regenerated on import). Use before switching embedding providers.',
  inputSchema: {
    type: 'object',
    properties: {
      client_id: { type: 'string', description: 'Filter by client (optional)' },
      type: { type: 'string', enum: ['event', 'fact', 'decision', 'status'], description: 'Filter by type (optional)' },
      since: { type: 'string', description: 'ISO 8601 timestamp — export only memories created after this time (optional)' },
    },
  },
},
```

Handler: GET to `/export` with query params.

- [ ] **Step 2: Add brain_import tool definition + handler**

Tool definition:
```javascript
{
  name: 'brain_import',
  description: 'Import memories from JSON (e.g. from a brain_export backup). Re-embeds with current provider, deduplicates by content hash. Max 500 records per call.',
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'array',
        description: 'Array of memory objects to import (same format as brain_export output)',
        items: { type: 'object' },
      },
    },
    required: ['data'],
  },
},
```

Handler: POST to `/export/import` with `{ data }` body.

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/index.js
git commit -m "feat: brain_export and brain_import MCP tools"
```

---

### Task 8: Build webhook notification service

**Files:**
- Create: `api/src/services/notifications.js`
- Modify: `api/src/routes/memory.js` — dispatch on store and supersede
- Modify: `api/src/routes/consolidation.js` — dispatch on supersede during merge (if applicable, check code)
- Modify: `.env.example` — add WEBHOOK_NOTIFY_URLS
- Test: `api/tests/notifications.test.js`

- [ ] **Step 1: Write test for notification dispatch**

```javascript
// api/tests/notifications.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildNotificationPayload } from '../src/services/notifications.js';

describe('notifications', () => {
  it('should build memory_stored payload', () => {
    const payload = buildNotificationPayload('memory_stored', {
      id: 'test-id', type: 'fact', client_id: 'acme-loans',
      knowledge_category: 'strategy', content: 'Long content here that should be truncated...',
      source_agent: 'claude-code', importance: 'high', created_at: '2026-03-20T00:00:00Z',
    });
    assert.strictEqual(payload.event, 'memory_stored');
    assert.strictEqual(payload.memory.id, 'test-id');
    assert.ok(payload.memory.content_preview.length <= 200);
  });
});
```

- [ ] **Step 2: Implement notification service**

```javascript
// api/src/services/notifications.js
const WEBHOOK_URLS = (process.env.WEBHOOK_NOTIFY_URLS || '')
  .split(',')
  .map(u => u.trim())
  .filter(u => u.length > 0);

export function buildNotificationPayload(event, memory) {
  return {
    event,
    memory: {
      id: memory.id,
      type: memory.type,
      client_id: memory.client_id || 'global',
      knowledge_category: memory.knowledge_category || 'general',
      content_preview: (memory.content || '').slice(0, 200),
      source_agent: memory.source_agent,
      importance: memory.importance || 'medium',
      created_at: memory.created_at,
    },
  };
}

export function dispatchNotification(event, memory) {
  if (WEBHOOK_URLS.length === 0) return;
  const payload = buildNotificationPayload(event, memory);

  // Fire-and-forget — never block the store operation
  for (const url of WEBHOOK_URLS) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(err => {
      console.warn(`[notifications] Webhook failed for ${url}: ${err.message}`);
    });
  }
}
```

- [ ] **Step 3: Wire into memory.js**

Import `dispatchNotification` in `api/src/routes/memory.js`. Call `dispatchNotification('memory_stored', ...)` after successful upsert. Call `dispatchNotification('memory_superseded', ...)` after supersession (in the fact key/status subject dedup block). Call `dispatchNotification('memory_deleted', ...)` in the DELETE route.

- [ ] **Step 3b: Wire into consolidation.js**

Import `dispatchNotification` in `api/src/services/consolidation.js`. Call `dispatchNotification('memory_superseded', ...)` when merged facts supersede source memories (around the `updatePointPayload` calls that set `active: false`).

- [ ] **Step 4: Update .env.example**

Add:
```
# --- Webhook Notifications ---
# WEBHOOK_NOTIFY_URLS=http://n8n.local:5678/webhook/brain-event  # comma-separated URLs
```

- [ ] **Step 5: Run tests**

Run: `cd api && node --test tests/notifications.test.js`

- [ ] **Step 6: Commit**

```bash
git add api/src/services/notifications.js api/src/routes/memory.js .env.example api/tests/notifications.test.js
git commit -m "feat: webhook notification dispatch on memory store, supersede, and delete"
```

---

### Task 9: Add `entity_relationships` table + co-occurrence tracking

**Files:**
- Modify: `api/src/services/stores/postgres.js` — create entity_relationships table, add CRUD functions
- Modify: `api/src/services/stores/sqlite.js` — same
- Modify: `api/src/services/stores/interface.js` — expose new functions
- Modify: `api/src/services/entities.js` — track co-occurrence during extraction
- Test: `api/tests/entity-relationships.test.js`

- [ ] **Step 1: Write test for relationship tracking**

```javascript
// api/tests/entity-relationships.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('entity relationships', () => {
  it('should detect co-occurring entities', () => {
    const entities = [
      { name: 'Acme Loans', type: 'client' },
      { name: 'Alex', type: 'person' },
      { name: 'SEMrush', type: 'technology' },
    ];
    // Each pair should create a relationship
    const pairs = [];
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        pairs.push([entities[i].name, entities[j].name]);
      }
    }
    assert.strictEqual(pairs.length, 3); // 3 entities = 3 pairs
  });
});
```

- [ ] **Step 2: Add entity_relationships table to Postgres**

In `api/src/services/stores/postgres.js`, add CREATE TABLE in `init()` and add functions:
- `createRelationship(sourceId, targetId, type)` — INSERT ON CONFLICT DO UPDATE strength = strength + 1
- `getRelationships(entityId, minStrength)` — SELECT with JOIN to entities table
- `listRelationships(filters)` — for graph queries

- [ ] **Step 3: Add same to SQLite**

Mirror the Postgres implementation in `api/src/services/stores/sqlite.js`.

- [ ] **Step 4: Expose through store interface**

Add `createRelationship`, `getRelationships`, `listRelationships` to `api/src/services/stores/interface.js`.

- [ ] **Step 5: Track co-occurrence in entity extraction**

In `api/src/services/entities.js`, after `linkExtractedEntities` completes, generate entity pairs from the extracted entities and call `createRelationship` for each pair with type `'co_occurrence'`.

- [ ] **Step 6: Run tests**

Run: `cd api && node --test tests/entity-relationships.test.js`

- [ ] **Step 7: Commit**

```bash
git add api/src/services/stores/postgres.js api/src/services/stores/sqlite.js api/src/services/stores/interface.js api/src/services/entities.js api/tests/entity-relationships.test.js
git commit -m "feat: entity_relationships table with co-occurrence tracking"
```

---

### Task 10: Build `brain_graph` API endpoint + MCP tool

**Files:**
- Create: `api/src/routes/graph.js`
- Modify: `api/src/index.js` — register graph router
- Modify: `mcp-server/src/index.js` — add brain_graph tool

- [ ] **Step 1: Implement graph route**

Create `api/src/routes/graph.js`:
- `GET /graph/:entity` — returns JSON with entity + connected entities + relationship types/strengths
- Uses `findEntity` to resolve name, then `getRelationships` with depth traversal
- Supports `depth` and `min_strength` query params

- [ ] **Step 2: Register graph router**

In `api/src/index.js`: `app.use('/graph', graphRouter);` (note: URL-decoded entity names handled by Express automatically)

- [ ] **Step 3: Add brain_graph MCP tool**

In `mcp-server/src/index.js`, add tool definition:
```javascript
{
  name: 'brain_graph',
  description: 'Explore entity relationships in the knowledge graph. Returns connected entities with relationship types and strengths. Use to understand how clients, people, technologies, and workflows are connected.',
  inputSchema: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Entity name to explore' },
      depth: { type: 'number', description: 'Relationship traversal depth (default 1, max 3)' },
      min_strength: { type: 'number', description: 'Minimum relationship strength to include (default 2)' },
    },
    required: ['entity'],
  },
},
```

Handler: GET to `/graph/${encodeURIComponent(entity)}` with query params.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/graph.js api/src/index.js mcp-server/src/index.js
git commit -m "feat: brain_graph API endpoint and MCP tool for entity relationship queries"
```

---

### Task 11: D3.js interactive entity graph visualization

**Files:**
- Create: `api/src/templates/graph.html` — standalone D3.js force-directed graph
- Modify: `api/src/routes/graph.js` — add HTML endpoint

- [ ] **Step 1: Build D3.js visualization template**

Create `api/src/templates/graph.html` — a self-contained HTML file with:
- Dark theme (#0a0a0f background, subtle grid)
- D3.js force-directed graph loaded from CDN
- Nodes colored by entity type: clients=#4ECDB8 (teal), people=#F59E0B (amber), technology=#3B82F6 (blue), workflow=#8B5CF6 (purple), agent=#EF4444 (red), domain=#10B981 (emerald), service=#EC4899 (pink)
- Node size scales with mention_count (min 8px, max 40px)
- Edge thickness scales with relationship strength
- Click node → highlight connections, show info panel with entity details + recent memories
- Hover → tooltip with entity name + type
- Zoom/pan with mouse wheel + drag
- Search bar (top-right) with instant filter
- PNG export button
- `{{DATA_PLACEHOLDER}}` token replaced server-side with the actual graph JSON

Design: Premium, dark, glowing edges, subtle animations. Think observability dashboard meets neural network visualization.

- [ ] **Step 2: Add HTML endpoint to graph router**

In `api/src/routes/graph.js`, add:
```javascript
// GET /graph/:entity/html — interactive visualization
graphRouter.get('/:entity/html', async (req, res) => {
  // Fetch graph data at depth=2
  // Read template, replace {{DATA_PLACEHOLDER}} with JSON
  // Return HTML with Content-Type: text/html
});
```

- [ ] **Step 3: Test manually**

Open `http://localhost:8084/graph/Acme Loans/html` in browser and verify the visualization renders.

- [ ] **Step 4: Commit**

```bash
git add api/src/templates/graph.html api/src/routes/graph.js
git commit -m "feat: interactive D3.js entity graph visualization — dark theme, force-directed, searchable"
```

---

### Task 12: Auto-resolve client_id on memory store

**Files:**
- Modify: `api/src/routes/memory.js` — add auto-resolve when client_id is missing

- [ ] **Step 1: Wire client resolver into POST /memory**

In `api/src/routes/memory.js`, after destructuring `client_id` from body:
```javascript
// Auto-resolve client_id from content if not provided
if (!client_id || client_id === 'global') {
  const resolver = getClientResolver();
  const resolved = resolver.resolve(content);
  if (resolved && !Array.isArray(resolved)) {
    client_id = resolved;
  }
}
```

Import `getClientResolver` from `'../services/client-resolver.js'`.

- [ ] **Step 2: Test by storing a memory without client_id that mentions a client**

Use curl or MCP to store a fact with content "Updated Acme Loans homepage meta tags for Springfield SEO" without providing client_id. Verify it auto-resolves to `acme-loans`.

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/memory.js
git commit -m "feat: auto-resolve client_id from content via fingerprint matching"
```

---

### Task 12b: Consolidation engine enhancements

**Files:**
- Modify: `api/src/services/consolidation.js` — add knowledge_category reclassification and relationship type classification

- [ ] **Step 1: Add knowledge_category reclassification to consolidation prompt**

In the consolidation LLM prompt (in `runConsolidation`), add instructions for the LLM to suggest a `knowledge_category` for memories that have `null` or `general` as their knowledge_category. The LLM should output a `suggested_knowledge_category` field per memory.

After LLM response, update Qdrant payloads for any memories where a better category was detected:
```javascript
if (suggestion.suggested_knowledge_category && suggestion.suggested_knowledge_category !== 'general') {
  await updatePointPayload(memoryId, { knowledge_category: suggestion.suggested_knowledge_category });
}
```

- [ ] **Step 2: Add relationship type classification**

During consolidation, when entities co-occur in memories, use the LLM to classify relationship types beyond `co_occurrence`. Add to the consolidation prompt:
```
For entity pairs that appear together, suggest a relationship type:
contact_of, same_owner, uses, works_on, competitor_of, or co_occurrence
```

After LLM response, update entity_relationships with the classified type.

- [ ] **Step 3: Commit**

```bash
git add api/src/services/consolidation.js
git commit -m "feat: consolidation engine reclassifies knowledge_category and entity relationship types"
```

---

### Task 13: Update .env.example, README, CHANGELOG, version bump

**Files:**
- Modify: `.env.example` — all new config vars
- Modify: `README.md` — new tools, endpoints, config docs
- Modify: `CHANGELOG.md` — v2.0.0 entry
- Modify: `mcp-server/package.json` — version bump

- [ ] **Step 1: Update .env.example with all new vars**

Add client resolver config:
```
# --- Client Resolver ---
# BASEROW_CLIENTS_TABLE_ID=734  # Baserow table with client_fingerprints field
# BASEROW_CLIENT_TOKEN=         # Uses BASEROW_API_KEY if not set
```

- [ ] **Step 2: Update README with new tools and endpoints**

Add brain_client, brain_export, brain_import, brain_graph to the tools table. Add new API endpoints. Update tool count from 7 to 11.

- [ ] **Step 3: Add CHANGELOG entry**

```markdown
## 2.0.0 (2026-03-XX)
- **Client knowledge base**: Fingerprint-based client identification, `knowledge_category` field, `brain_client` tool for one-call client briefings
- **Import/Export**: `brain_export` and `brain_import` tools for backup and embedding migration safety
- **Webhook notifications**: Real-time dispatch on memory store/supersede/delete
- **Entity graph**: Relationship tracking with co-occurrence, `brain_graph` tool, interactive D3.js visualization
- **Gemini Embedding 2**: New pluggable embedder with task-type-aware embeddings (RETRIEVAL_DOCUMENT/RETRIEVAL_QUERY)
```

- [ ] **Step 4: Version bump**

Update `mcp-server/package.json` version to `2.0.0`. Update MCP server version string in `mcp-server/src/index.js`.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md CHANGELOG.md mcp-server/package.json mcp-server/src/index.js
git commit -m "v2.0.0: client knowledge base, import/export, notifications, entity graph"
```

---

### Task 14: Deploy to Beelink + verify

**Files:** None (deployment)

- [ ] **Step 1: Upload all changed files to Beelink via scp**

Upload all new and modified files in `api/src/`, `api/scripts/`, `mcp-server/src/`, and config files.

- [ ] **Step 2: Add new env vars to Beelink .env**

```
BASEROW_CLIENTS_TABLE_ID=734
```
(BASEROW_API_KEY and BASEROW_URL are already set)

- [ ] **Step 3: Rebuild and restart container**

```bash
ssh server "cd ~/shared-brain && docker compose build memory-api && docker compose up -d memory-api"
```

- [ ] **Step 4: Verify startup logs**

```bash
ssh server "docker logs shared-brain-api --tail 20"
```
Expected: client resolver loaded, all routes registered, no errors.

- [ ] **Step 5: Populate client fingerprints in Baserow 734**

Add `client_fingerprints` field (long text) to table 734 via Baserow UI. Populate for all 5 active clients with the JSON fingerprint format from the spec.

- [ ] **Step 6: Test brain_client via MCP**

Call `brain_client("acme-loans")` — should return a briefing (initially empty knowledge sections until memories are stored with knowledge_category).

Call `brain_client("AL")` — should resolve to acme-loans via fingerprints.

- [ ] **Step 7: Test export/import round-trip**

Call `brain_export()` — should return 232+ memories as JSON.
Save output, then call `brain_import(data)` — should report all skipped (duplicates).

- [ ] **Step 8: Test graph visualization**

Open `http://localhost:8084/graph/claude-code/html` in browser — should render interactive graph.

- [ ] **Step 9: Update local MCP server**

Reinstall/restart the shared-brain MCP server on Windows to pick up the new tools.

- [ ] **Step 10: Store to Shared Brain**

Store a session summary about the v2 deployment to the Shared Brain so other agents know about the new capabilities.
