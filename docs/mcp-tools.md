# MCP Tool Reference

The Shared Brain MCP server exposes 14 tools via the Model Context Protocol (stdio transport). Agents like Claude Code interact with the memory system exclusively through these tools.

Server: `zengram` v2.4.0

## Configuration

The MCP server requires two environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `BRAIN_API_URL` | No | API base URL (default: `http://localhost:8084`) |
| `BRAIN_API_KEY` | Yes | Authentication key (admin or agent-scoped) |
| `BRAIN_MCP_TIMEOUT` | No | Default timeout for API calls in ms (default: 15000) |
| `BRAIN_MCP_CONSOLIDATION_TIMEOUT` | No | Timeout for consolidation/reflect calls (default: 120000) |

## Tool Inventory

| Tool | Purpose | API Endpoint |
|------|---------|-------------|
| `brain_store` | Store a memory | POST /memory |
| `brain_search` | Multi-path search | GET /memory/search |
| `brain_briefing` | Session briefing | GET /briefing |
| `brain_query` | Structured database query | GET /memory/query |
| `brain_stats` | Memory health stats | GET /stats |
| `brain_consolidate` | Trigger/poll consolidation | POST/GET /consolidate |
| `brain_entities` | Entity graph queries | GET /entities/* |
| `brain_graph` | Entity relationships | GET /graph/:entity |
| `brain_delete` | Soft-delete a memory | DELETE /memory/:id |
| `brain_update` | Update existing memory | PATCH /memory/:id |
| `brain_client` | Client briefing/search | GET /client/:id |
| `brain_export` | Export memories as JSON | GET /export |
| `brain_import` | Import memories from JSON | POST /export/import |
| `brain_reclassify` | Fix entity type misclassifications | GET/POST /entities/reclassify |
| `brain_reflect` | LLM synthesis on a topic | POST /reflect |

---

## brain_store

Store a memory in the Shared Brain. Supports four memory types with automatic deduplication, entity extraction, and supersedes logic.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | `event`, `fact`, `decision`, `status` |
| `content` | string | Yes | Memory text. Be specific and include context. |
| `source_agent` | string | Yes | Agent identifier (default: `"claude-code"` if omitted via MCP) |
| `client_id` | string | No | Client slug or `"global"` |
| `category` | string | No | `semantic`, `episodic`, `procedural` |
| `importance` | string | No | `critical`, `high`, `medium`, `low` |
| `key` | string | No | **Facts only**: unique key for upsert. Existing fact with same key is superseded. |
| `subject` | string | No | **Status only**: what this status is about. Existing status with same subject is superseded. |
| `status_value` | string | No | **Status only**: the current value |
| `knowledge_category` | string | No | `brand`, `strategy`, `meeting`, `content`, `technical`, `relationship`, `general` |
| `valid_from` | string | No | ISO 8601 -- when this fact became true |
| `valid_to` | string | No | ISO 8601 -- when this fact stopped being true |

**When to use which type:**
- `event` -- Something happened (append-only, auto-expires after 30 days if never accessed and medium/low importance)
- `fact` -- Persistent knowledge that gets updated over time (always provide a `key` for clean supersedes)
- `decision` -- A choice made and why (append-only, never expires)
- `status` -- Current state of a system or workflow (always provide `subject`)

**Example:**

```json
{
  "type": "fact",
  "content": "Acme Corp migrated from WordPress to Next.js 14 in March 2026",
  "source_agent": "claude-code",
  "client_id": "acme-corp",
  "key": "acme-tech-stack",
  "importance": "high",
  "knowledge_category": "technical"
}
```

---

## brain_search

Multi-path search using vector (semantic), keyword (BM25 exact match), and graph (entity BFS) retrieval in parallel, fused with Reciprocal Rank Fusion.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Natural language search query |
| `type` | string | No | Filter by memory type |
| `source_agent` | string | No | Filter by agent |
| `client_id` | string | No | Filter by client |
| `limit` | number | No | Max results (default 10) |
| `format` | string | No | `compact` (default, saves tokens) or `full` (shows retrieval sources) |
| `include_superseded` | boolean | No | Include inactive memories |
| `knowledge_category` | string | No | Filter by knowledge domain |
| `at_time` | string | No | ISO 8601 -- "what was true at this time?" |

**Example:**

```json
{
  "query": "what tech stack does acme use",
  "client_id": "acme-corp",
  "type": "fact",
  "format": "compact"
}
```

**When to use**: For any semantic/natural-language question about stored knowledge. Default tool for retrieval.

---

## brain_briefing

Get a session briefing showing what happened across all agents since a given time. Excludes the requesting agent's own entries by default.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `since` | string | Yes | ISO 8601 timestamp |
| `agent` | string | No | Requesting agent (default: `"claude-code"`) |
| `include` | string | No | `"all"` to include own entries |
| `format` | string | No | `compact` (default), `summary` (minimal), `full` |
| `limit` | number | No | Max memories (default 100, max 500) |

**Example:**

```json
{
  "since": "2026-03-28T00:00:00Z",
  "agent": "claude-code",
  "format": "compact"
}
```

**When to use**: At the start of every session to catch up on what other agents did.

---

## brain_query

Structured database query. Use for exact lookups by key, subject, or time range. Unlike `brain_search`, this queries the structured store (SQLite/Postgres) directly -- no semantic matching.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | `events`, `facts`, `statuses` |
| `source_agent` | string | No | Filter by agent |
| `category` | string | No | Filter by category |
| `client_id` | string | No | Filter by client |
| `since` | string | No | For events: ISO timestamp |
| `key` | string | No | For facts: search by key |
| `subject` | string | No | For statuses: search by subject |

**Example:**

```json
{
  "type": "statuses",
  "client_id": "acme-corp"
}
```

**When to use**: When you know the exact key/subject of what you need, or want all current statuses.

---

## brain_stats

Get memory health statistics. No parameters.

**Example:**

```json
{}
```

**When to use**: To understand the state of the brain -- how many memories, what types, is retrieval working, are things decaying.

---

## brain_consolidate

Trigger or monitor the consolidation engine.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | No | `run` (default), `status`, `job` |
| `job_id` | string | No | For `action=job`: poll a running job |
| `sync` | boolean | No | For `action=run`: block until complete (default: false) |

**Example -- Async trigger:**

```json
{"action": "run"}
```

Response: `{"status": "started", "job_id": "uuid"}`. Poll with `{"action": "job", "job_id": "uuid"}`.

**Example -- Check status:**

```json
{"action": "status"}
```

**When to use**: After large bulk stores, or to manually trigger if the schedule hasn't run recently.

---

## brain_entities

Query the entity knowledge graph.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | `list`, `get`, `memories`, `stats` |
| `name` | string | For get/memories | Entity name (canonical or alias) |
| `type` | string | For list | Filter: `client`, `person`, `system`, `service`, `domain`, `technology`, `workflow`, `agent` |
| `limit` | number | No | Max results (default 50) |

**Examples:**

```json
{"action": "list", "type": "client"}
{"action": "get", "name": "Next.js"}
{"action": "memories", "name": "acme-corp", "limit": 20}
{"action": "stats"}
```

**When to use**: To explore what entities the system knows about, find all memories about a specific entity, or check entity health stats.

---

## brain_graph

Explore entity relationships with traversal depth control.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `entity` | string | Yes | Entity name to explore |
| `depth` | number | No | Traversal depth (default 1, max 3) |
| `min_strength` | number | No | Min relationship strength (default 1) |

**Example:**

```json
{"entity": "acme-corp", "depth": 2}
```

**When to use**: To understand how entities relate -- who works on what, which technologies a client uses, etc.

---

## brain_delete

Soft-delete a memory by ID.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `memory_id` | string | Yes | UUID of the memory |
| `reason` | string | No | Reason for deletion (logged for audit) |

**Example:**

```json
{"memory_id": "abc-123-def", "reason": "Contains incorrect information"}
```

**When to use**: To remove incorrect, sensitive, or outdated memories. Agent-scoped keys can only delete their own memories.

---

## brain_update

Update an existing memory in place without creating a new version.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `memory_id` | string | Yes | UUID of the memory |
| `content` | string | No | New content (triggers re-embed + re-index) |
| `importance` | string | No | New importance level |
| `knowledge_category` | string | No | New knowledge category |
| `metadata` | object | No | Updated metadata (replaces existing) |

At least one field besides `memory_id` is required.

**Example:**

```json
{"memory_id": "abc-123-def", "importance": "critical", "knowledge_category": "technical"}
```

**When to use**: For corrections or promotions/demotions of importance. Prefer `brain_store` with a `key` for facts that change over time (the supersedes mechanism is cleaner).

---

## brain_client

Get everything known about a client, organized by knowledge category.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `client` | string | Yes | Client ID or fuzzy name |
| `category` | string | No | Filter: `brand`, `strategy`, `meeting`, `content`, `technical`, `relationship` |
| `query` | string | No | Semantic search within client (omit for full briefing) |
| `format` | string | No | `compact` (default) or `full` |

**Example:**

```json
{"client": "acme", "category": "technical", "format": "compact"}
```

**When to use**: When starting work on a client to get full context. Accepts fuzzy names -- "AL" resolves to "acme-loans" via client fingerprints.

---

## brain_export

Export memories as JSON for backup or migration.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `client_id` | string | No | Filter by client |
| `type` | string | No | Filter by type |
| `since` | string | No | ISO timestamp |
| `limit` | number | No | Max records (default 500) |

**Example:**

```json
{"client_id": "acme-corp", "limit": 1000}
```

**When to use**: For backups, migration between instances, or auditing.

---

## brain_import

Import memories from JSON backup.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | array | Yes | Array of memory objects (same format as export output) |

Max 500 records per call. Deduplicates by content hash. Re-embeds with current provider.

**When to use**: Restoring from backup or migrating from another instance.

---

## brain_reclassify

Fix entity type misclassifications in the knowledge graph.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | `suggest` (auto-detect) or `apply` (reclassify) |
| `reclassifications` | array | For apply | `[{"name": "Baserow", "new_type": "technology"}]` |
| `dry_run` | boolean | For apply | Preview changes (default: true) |

**Example -- Get suggestions:**

```json
{"action": "suggest"}
```

**Example -- Apply with preview:**

```json
{
  "action": "apply",
  "reclassifications": [{"name": "Baserow", "new_type": "technology"}],
  "dry_run": true
}
```

**When to use**: After consolidation discovers entities with wrong types. Always run `dry_run: true` first.

---

## brain_reflect

LLM-powered synthesis that analyzes memories about a topic and identifies patterns, timeline, contradictions, and knowledge gaps.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `topic` | string | Yes | Topic or question to reflect on |
| `client_id` | string | No | Scope to a specific client |
| `limit` | number | No | Max memories to analyze (default 20, max 50) |

**Example:**

```json
{"topic": "deployment automation", "client_id": "acme-corp", "limit": 30}
```

**When to use**: For "what do we know about X?", "what patterns do you see?", or "what's missing?" questions. Uses the consolidation LLM timeout (120s default).

---

## Tool Selection Guide

| I want to... | Use this tool |
|--------------|---------------|
| Record something that happened | `brain_store` (type: event) |
| Save persistent knowledge | `brain_store` (type: fact, with key) |
| Record a decision | `brain_store` (type: decision) |
| Update a system's status | `brain_store` (type: status, with subject) |
| Find memories about a topic | `brain_search` |
| Get exact fact by key | `brain_query` (type: facts, key: ...) |
| Catch up on what happened | `brain_briefing` |
| See brain health | `brain_stats` |
| Learn about a client | `brain_client` |
| Explore entity connections | `brain_graph` |
| Ask "what do we know about X?" | `brain_reflect` |
| Fix incorrect memory | `brain_update` or `brain_delete` |
| Backup memories | `brain_export` |
| Restore from backup | `brain_import` |
| Fix entity types | `brain_reclassify` |
| Force consolidation | `brain_consolidate` |

## Cross-References

- [API Reference](api-reference.md) -- underlying HTTP endpoints
- [Data Model](data-model.md) -- memory types, scoring, supersedes
- [Configuration](configuration.md) -- MCP timeout settings
