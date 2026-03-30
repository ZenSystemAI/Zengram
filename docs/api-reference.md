# API Reference

Base URL: `http://localhost:8084`

All endpoints except `/health` and `/dashboard` require the `x-api-key` header.

## Authentication

```
x-api-key: <BRAIN_API_KEY or AGENT_KEY_*>
```

- **Admin key** (`BRAIN_API_KEY`): full access, no agent identity binding
- **Agent keys** (`AGENT_KEY_<name>`): binds `req.authenticatedAgent` to the agent name; `source_agent` must match on writes; agents can only update/delete their own memories

All responses include an `x-request-id` header (pass your own via the request header or one is generated).

---

## Health

### GET /health

No authentication required.

```bash
curl http://localhost:8084/health
```

```json
{
  "status": "ok",
  "service": "zengram",
  "timestamp": "2026-03-29T12:00:00.000Z"
}
```

---

## Memory

### POST /memory -- Store a Memory

```bash
curl -X POST http://localhost:8084/memory \
  -H "x-api-key: KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "fact",
    "content": "Acme Corp uses Next.js 14 with App Router",
    "source_agent": "claude-code",
    "client_id": "acme-corp",
    "key": "acme-tech-stack",
    "importance": "high",
    "knowledge_category": "technical"
  }'
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | `event`, `fact`, `decision`, `status` |
| `content` | string | Yes | Memory text (max 10,000 chars) |
| `source_agent` | string | Yes | Agent identifier (1-64 chars, alphanumeric/hyphens/underscores) |
| `client_id` | string | No | Client slug or `"global"` (default). Auto-resolved from content if omitted. |
| `category` | string | No | `semantic`, `episodic`, `procedural` (default: `episodic`) |
| `importance` | string | No | `critical`, `high`, `medium`, `low` (default: `medium`) |
| `knowledge_category` | string | No | `brand`, `strategy`, `meeting`, `content`, `technical`, `relationship`, `general` |
| `key` | string | No | Facts only: unique key for upsert/supersede (max 128 chars) |
| `subject` | string | No | Status only: what this status is about (max 256 chars) |
| `status_value` | string | No | Status only: the current value (max 256 chars) |
| `metadata` | object | No | Arbitrary metadata (max 10KB, max 3 levels deep) |
| `valid_from` | string | No | ISO 8601 timestamp when this fact became true |
| `valid_to` | string | No | ISO 8601 timestamp when this fact stopped being true |

**Response (201 Created):**

```json
{
  "id": "uuid",
  "type": "fact",
  "content_hash": "abc123def456",
  "deduplicated": false,
  "supersedes": "old-uuid-or-null",
  "stored_in": { "qdrant": true, "structured_db": true }
}
```

**Response (200 -- Deduplicated):**

```json
{
  "id": "existing-uuid",
  "type": "fact",
  "content_hash": "abc123def456",
  "deduplicated": true,
  "observed_by": ["claude-code"],
  "observation_count": 1,
  "message": "Exact duplicate from same agent -- returning existing memory"
}
```

**Response (200 -- Corroborated):**

```json
{
  "id": "existing-uuid",
  "corroborated": true,
  "observed_by": ["claude-code", "n8n"],
  "observation_count": 2,
  "message": "Cross-agent corroboration recorded -- now observed by 2 agents"
}
```

### GET /memory/search -- Multi-Path Search

```bash
curl -H "x-api-key: KEY" \
  "http://localhost:8084/memory/search?q=Next.js+deployment&client_id=acme-corp&format=compact&limit=5"
```

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `q` | string | Yes | Natural language search query |
| `type` | string | No | Filter: `event`, `fact`, `decision`, `status` |
| `source_agent` | string | No | Filter by agent |
| `client_id` | string | No | Filter by client |
| `category` | string | No | Filter: `semantic`, `episodic`, `procedural` |
| `knowledge_category` | string | No | Filter by knowledge domain |
| `limit` | number | No | Max results (default 10, max 100) |
| `format` | string | No | `compact` (200 char truncated), `full` (with retrieval sources) |
| `include_superseded` | string | No | `"true"` to include inactive memories |
| `entity` | string | No | Filter by entity name (disables multi-path, Qdrant-only) |
| `at_time` | string | No | ISO 8601 timestamp for temporal query ("what was true at X?") |

**Response:**

```json
{
  "query": "Next.js deployment",
  "count": 3,
  "results": [
    {
      "id": "uuid",
      "score": 0.8721,
      "effective_score": 0.9134,
      "type": "fact",
      "content": "Acme Corp uses Next.js 14...",
      "source_agent": "claude-code",
      "client_id": "acme-corp",
      "importance": "high",
      "created_at": "2026-03-15T10:00:00Z"
    }
  ],
  "retrieval": {
    "multi_path": true,
    "paths": { "vector": 8, "keyword": 3, "graph": 2 }
  }
}
```

The `retrieval` block only appears with `format=full`.

### GET /memory/query -- Structured Query

```bash
# Query facts by key
curl -H "x-api-key: KEY" \
  "http://localhost:8084/memory/query?type=facts&key=acme-tech-stack"

# Query statuses by subject
curl -H "x-api-key: KEY" \
  "http://localhost:8084/memory/query?type=statuses&subject=deploy-pipeline"

# Query events since timestamp
curl -H "x-api-key: KEY" \
  "http://localhost:8084/memory/query?type=events&since=2026-03-28T00:00:00Z"
```

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes (for DB query) | `events`, `facts`, `statuses` |
| `source_agent` | string | No | Filter by agent |
| `category` | string | No | Filter by category |
| `client_id` | string | No | Filter by client |
| `since` | string | No | For events: ISO timestamp |
| `key` | string | No | For facts: search by key |
| `subject` | string | No | For statuses: search by subject |

### PATCH /memory/:id -- Update a Memory

```bash
curl -X PATCH http://localhost:8084/memory/UUID \
  -H "x-api-key: KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "Updated content", "importance": "critical"}'
```

**Request Body** (at least one field required):

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | New content (triggers re-embed, re-hash, re-index, re-entity-extract) |
| `importance` | string | New importance level |
| `knowledge_category` | string | New knowledge category |
| `metadata` | object | New metadata (replaces existing) |

Agent-scoped keys can only update memories where `source_agent` matches the authenticated agent.

**Response:**

```json
{
  "id": "uuid",
  "updated": true,
  "updated_at": "2026-03-29T12:00:00Z",
  "updated_fields": ["content", "importance"]
}
```

### DELETE /memory/:id -- Soft-Delete a Memory

```bash
curl -X DELETE http://localhost:8084/memory/UUID \
  -H "x-api-key: KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Incorrect information"}'
```

Sets `active: false`. Memory remains in storage but is excluded from search. Agent-scoped keys can only delete their own memories.

**Response:**

```json
{
  "id": "uuid",
  "deleted": true,
  "deleted_at": "2026-03-29T12:00:00Z",
  "deleted_by": "claude-code"
}
```

---

## Briefing

### GET /briefing -- Session Briefing

```bash
curl -H "x-api-key: KEY" \
  "http://localhost:8084/briefing?since=2026-03-28T00:00:00Z&agent=claude-code&format=compact"
```

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `since` | string | Yes | ISO 8601 timestamp |
| `agent` | string | No | Requesting agent (their entries are excluded unless `include=all`) |
| `include` | string | No | `"all"` to include own entries |
| `format` | string | No | `compact` (default, 200 chars, skips low-importance events), `summary` (counts + headlines), `full` (complete content) |
| `limit` | number | No | Max memories (default 100, max 500) |

**Response** includes: `summary` (counts, active agents, mentioned clients, top entities), plus buckets of `events`, `facts_updated`, `status_changes`, `decisions` sorted by importance then recency.

---

## Stats

### GET /stats -- Memory Health Dashboard

```bash
curl -H "x-api-key: KEY" http://localhost:8084/stats
```

**Response:**

```json
{
  "total_memories": 1847,
  "vectors_count": 1847,
  "active": 1523,
  "superseded": 324,
  "consolidated": 1200,
  "by_type": { "event": 800, "fact": 600, "decision": 200, "status": 247 },
  "decayed_below_50pct": 12,
  "decay_config": { "factor": 0.98, "affected_types": ["fact", "status"] },
  "entities": { "total": 340, "by_type": {"technology": 80, "client": 25, ...}, "top_mentioned": [...] },
  "retrieval": {
    "multi_path": true,
    "keyword_search": true,
    "keyword_index_count": 1523,
    "graph_search": true
  }
}
```

---

## Entities

### GET /entities -- List Entities

```bash
curl -H "x-api-key: KEY" "http://localhost:8084/entities?type=client&limit=50&offset=0"
```

### GET /entities/stats -- Entity Statistics

```bash
curl -H "x-api-key: KEY" http://localhost:8084/entities/stats
```

### GET /entities/:name -- Get Single Entity

```bash
curl -H "x-api-key: KEY" "http://localhost:8084/entities/Next.js"
```

Resolves aliases: if you pass "nextjs" it resolves to "Next.js".

### GET /entities/:name/memories -- Entity's Linked Memories

```bash
curl -H "x-api-key: KEY" "http://localhost:8084/entities/Next.js/memories?limit=20"
```

### GET /entities/reclassify/suggestions -- Auto-Detect Misclassifications

```bash
curl -H "x-api-key: KEY" http://localhost:8084/entities/reclassify/suggestions
```

Returns heuristic-based suggestions for entities whose type seems wrong.

### POST /entities/reclassify -- Reclassify Entity Types

```bash
curl -X POST http://localhost:8084/entities/reclassify \
  -H "x-api-key: KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "reclassifications": [
      {"name": "Baserow", "new_type": "technology"}
    ],
    "dry_run": true
  }'
```

- `dry_run: true` (default): preview changes without applying
- `dry_run: false`: updates entity type in structured store, updates all Qdrant payloads in chunks of 100, logs reclassification as an event

---

## Graph

### GET /graph/:entity -- Entity Graph (JSON)

```bash
curl -H "x-api-key: KEY" "http://localhost:8084/graph/Next.js?depth=2&min_strength=1"
```

Returns `{nodes: [...], edges: [...], center: "Next.js"}` for D3.js consumption.

### GET /graph/:entity/html -- Entity Graph (Interactive HTML)

```bash
# Opens in browser
open "http://localhost:8084/graph/Next.js/html?depth=2"
```

### GET /graph/html -- Entity Browser Index

```bash
open "http://localhost:8084/graph/html?key=YOUR_KEY"
```

Lists all entities grouped by type with links to individual graph visualizations.

### GET /graph/full/html -- Full Brain Graph

```bash
open "http://localhost:8084/graph/full/html"
```

Shows top 80 entities by mention count with co-occurrence edges.

---

## Client

### GET /client/fingerprints -- Raw Client Fingerprints

```bash
curl -H "x-api-key: KEY" http://localhost:8084/client/fingerprints
```

Returns the client resolver's fingerprint data (aliases, people, domains, keywords) for external consumers like Fireflies or n8n.

### GET /client/:clientId -- Client Briefing or Search

```bash
# Briefing mode: all knowledge categories
curl -H "x-api-key: KEY" "http://localhost:8084/client/acme-corp?format=compact"

# Search mode: semantic search within client
curl -H "x-api-key: KEY" \
  "http://localhost:8084/client/acme-corp?query=tech+stack&category=technical&format=compact"
```

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `query` | string | Semantic search within client (omit for full briefing) |
| `category` | string | Filter by knowledge category |
| `format` | string | `compact` or `full` |

Accepts fuzzy client names: "AL" resolves to "acme-loans" if configured in fingerprints.

---

## Export / Import

### GET /export -- Export Memories as JSON

```bash
curl -H "x-api-key: KEY" \
  "http://localhost:8084/export?client_id=acme-corp&type=fact&limit=1000&offset=0"
```

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `client_id` | string | Filter by client |
| `type` | string | Filter by type |
| `since` | string | ISO timestamp -- only memories after this |
| `active_only` | string | `"false"` to include inactive (default: true) |
| `limit` | number | Max records (default 1000, max 5000) |
| `offset` | number | Skip first N records |

**Response** includes `has_more: true` when more records exist beyond the offset+limit.

### POST /export/import -- Import Memories

```bash
curl -X POST http://localhost:8084/export/import \
  -H "x-api-key: KEY" \
  -H "Content-Type: application/json" \
  -d '{"data": [{"type":"fact","content":"...","source_agent":"import","client_id":"acme"}]}'
```

Max 500 records per call. Deduplicates by content hash (tenant-scoped). Re-embeds with current provider. Processes in batches of 10 with 100ms delays.

---

## Consolidation

### POST /consolidate -- Trigger Consolidation

```bash
# Async (returns job ID immediately)
curl -X POST -H "x-api-key: KEY" http://localhost:8084/consolidate

# Sync (blocks until complete)
curl -X POST -H "x-api-key: KEY" "http://localhost:8084/consolidate?sync=true"
```

**Async Response (202):**

```json
{"status": "started", "job_id": "uuid"}
```

### GET /consolidate/job/:id -- Poll Job Status

```bash
curl -H "x-api-key: KEY" http://localhost:8084/consolidate/job/UUID
```

### GET /consolidate/status -- Consolidation Engine Status

```bash
curl -H "x-api-key: KEY" http://localhost:8084/consolidate/status
```

```json
{
  "is_running": false,
  "last_run_at": "2026-03-29T06:00:00Z",
  "llm": {"provider": "openai", "model": "gpt-4o-mini"},
  "enabled": true,
  "interval": "0 */6 * * *"
}
```

---

## Webhook

### POST /webhook/n8n -- n8n Workflow Ingestion

```bash
curl -X POST http://localhost:8084/webhook/n8n \
  -H "x-api-key: KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "workflow_name": "seo-rank-update",
    "workflow_id": "abc123",
    "execution_id": "exec_456",
    "status": "success",
    "message": "Updated 42 keywords",
    "client_id": "acme-corp",
    "items_processed": 42
  }'
```

**Required fields**: `workflow_name`, `status` (`success` or `error`). If `status=error`, also creates a status update for the workflow.

---

## Reflect

### POST /reflect -- LLM-Powered Topic Synthesis

```bash
curl -X POST http://localhost:8084/reflect \
  -H "x-api-key: KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic": "deployment pipeline", "client_id": "acme-corp", "limit": 20}'
```

**Response:**

```json
{
  "topic": "deployment pipeline",
  "client_id": "acme-corp",
  "memories_analyzed": 15,
  "reflection": {
    "summary": "...",
    "patterns": ["..."],
    "timeline": ["..."],
    "contradictions": ["..."],
    "gaps": ["..."]
  },
  "llm": {"provider": "openai", "model": "gpt-4o-mini"}
}
```

---

## Subscribe (SSE)

### GET /subscribe -- Real-Time Event Stream

```bash
curl -N -H "x-api-key: KEY" \
  "http://localhost:8084/subscribe?events=memory:stored,memory:superseded&client_id=acme-corp"
```

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `events` | string | Comma-separated event types to filter |
| `client_id` | string | Only receive events for this client |

**Event types**: `memory:stored`, `memory:superseded`, `memory:deleted`, `memory:consolidated`, `entity:created`, `entity:linked`

Returns Server-Sent Events (SSE). Max 50 concurrent subscribers. Sends keepalive comments every 30 seconds.

---

## Dashboard

### GET /dashboard -- HTML Dashboard

No authentication. Serves a static HTML page that makes authenticated API calls via JavaScript.

---

## Error Responses

All errors follow this format:

```json
{"error": "Description of what went wrong"}
```

| Status | Meaning |
|--------|---------|
| 400 | Invalid input (missing fields, bad types, content too long) |
| 401 | Missing or invalid API key |
| 403 | Agent identity mismatch (agent trying to modify another agent's memory) |
| 404 | Memory or entity not found |
| 409 | Consolidation already running |
| 429 | Rate limited (check `Retry-After` header) |
| 500 | Internal server error |
| 502 | LLM returned invalid response (reflect endpoint) |
| 503 | SSE subscriber limit reached |

## Cross-References

- [MCP Tools](mcp-tools.md) -- the MCP wrappers around these endpoints
- [Architecture](architecture.md) -- data flow diagrams
- [Data Model](data-model.md) -- memory types and scoring details
