# Shared Brain v2 — Design Spec

> Date: 2026-03-20
> Status: Draft
> Scope: Client knowledge base, import/export, auto-capture, notifications, entity graph

## Problem

The Shared Brain (v1.5) provides cross-agent memory but lacks:
- Reliable client attribution — Fireflies and agents misidentify which client content belongs to
- Structured client knowledge — brand, strategy, meetings, and relationships are scattered across Baserow, local files, and loosely tagged memories
- Data safety — switching embedding providers can destroy vectors with no recovery path
- Proactive sharing — agents only learn about changes at session start via briefings
- Entity context — entities are extracted but relationships aren't tracked or visualized

## Design

### 1. Client Fingerprint System

Each client gets a fingerprint dictionary stored in Baserow table 734 (clients) as a new `client_fingerprints` JSON field.

**Fingerprint format**:
```json
{
  "aliases": ["acme-loans", "acme loans", "AL"],
  "people": ["Alex"],
  "domains": ["acme-loans.ca"],
  "keywords": ["Springfield", "small-loans"],
  "related_clients": ["quickcredit"]
}
```

**Known fingerprints at launch**:
- `acme-loans`: aliases [AL, Acme Loans], people [Alex], domains [acme-loans.ca], keywords [Springfield]
- `quickcredit`: aliases [QuickCredit, QC], people [Alex], domains [quickcredit.com], keywords [Riverside]
- `greenlife`: aliases [GL], people [Jordan], domains [greenlife.ca]
- `riverside-inn`: aliases [Riverside Inn, Riverside], domains [riverside-inn.com]
- `localagency`: aliases [LA, Local Agency], people [Sam], domains [localagency.ca]

**API-side resolver** — `resolveClientId(text)`:
1. On startup, fetches all fingerprints from Baserow 734 and caches them
2. Cache refreshes every hour (or on-demand via API call)
3. For any text input: regex matches against all fingerprints (case-insensitive, accent-normalized)
4. Scores each client by hit count across alias/people/domain/keyword matches
5. Returns highest-scoring client_id, or array if multiple clients detected (each above threshold), or null if no match
6. Configurable threshold — minimum 2 hits to avoid false positives on common words
7. Tiebreaker: if two clients tie, return both (let caller decide or treat as multi-client content)
8. Below-threshold results: if only one client matches with 1 hit and no other client scores, return null (not enough signal). The `related_clients` field is informational only — used by agents calling `brain_client` to suggest related context, not used in scoring

**File**: `api/src/services/client-resolver.js`

**Integration points**:
- `POST /memory` — if `client_id` not provided, runs resolver on content and auto-tags
- Fireflies workflow — fingerprints injected into LLM extraction prompt
- `brain_store` MCP tool — optional `client_id` auto-resolved if omitted

### 2. Knowledge Categories

New `knowledge_category` field added to:
- Qdrant payload (keyword-indexed for filtering — add to `initQdrant()` index list)
- Postgres tables (events, facts, statuses — new column)
- `brain_store` MCP tool input schema (new optional parameter)
- `brain_search` MCP tool filter options (new optional parameter)

**Values**: `brand`, `strategy`, `meeting`, `content`, `technical`, `relationship`, `general`

**Relationship to existing `category` field**: The existing `category` field (`semantic`, `episodic`, `procedural`) describes _how_ a memory is structured (cognitive type). `knowledge_category` describes _what domain_ it belongs to (business context). Both fields coexist — they serve different purposes. Example: a meeting note about SEO strategy is `category: "episodic"` + `knowledge_category: "meeting"`. A brand voice guideline is `category: "semantic"` + `knowledge_category: "brand"`.

**Default behavior**:
- If not provided on store, defaults to `general`
- Existing memories (232) have `null` — treated as `general` in all queries
- Consolidation engine can reclassify during 6h pass if it detects a better category

**No migration required** — additive field, backward compatible.

### 3. `brain_client` MCP Tool

One-call access to everything known about a client.

**Parameters**:
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `client` | string | yes | Client ID or fuzzy name (resolved via fingerprints) |
| `category` | string | no | Filter by knowledge_category |
| `query` | string | no | Semantic search within this client's memories |
| `format` | string | no | `compact` (default) or `full` |

**Behavior — no query (briefing mode)**:
1. Resolve `client` to `client_id` via fingerprint resolver
2. Fetch client profile row from Baserow 734
3. For each knowledge_category, scroll Qdrant with client_id filter, then sort results in-memory by `created_at` descending, take top 2-3. (Qdrant scroll does not support payload sorting — sort is done application-side.)
4. Return structured response:
```json
{
  "client_id": "acme-loans",
  "profile": { "name": "Acme Loans", "industry": "loans", "brand_voice_tone": "helpful", ... },
  "knowledge": {
    "brand": [...],
    "strategy": [...],
    "meeting": [...],
    "content": [...],
    "technical": [...],
    "relationship": [...]
  }
}
```

**Behavior — with query (search mode)**:
1. Resolve client_id
2. Semantic search with client_id filter (+ optional category filter)
3. Return ranked results (same format as brain_search)

**API endpoint**: `GET /memory/client/:clientId`

### 4. Fireflies Integration Fix

The existing Fireflies daily processor workflow (`E:\dev\n8n\fireflies-daily-processor.json`) needs two changes:

**A. Fingerprint injection**: Before the LLM extraction node, add a step that fetches fingerprints from the Shared Brain API (new endpoint: `GET /clients/fingerprints`) and formats them into the extraction prompt:
```
Active clients and identifiers:
- acme-loans (aliases: AL, Acme Loans | people: Alex | domains: acme-loans.ca)
- quickcredit (aliases: QuickCredit | people: Alex | domains: quickcredit.com)
- greenlife (aliases: GL | people: Jordan | domains: greenlife.ca)
...

For each topic/action item, identify which client_id it belongs to.
If a segment doesn't match any client, use "internal".
```

**B. Multi-client output**: LLM returns structured output with `client_id` per extracted item. Each item becomes a separate `brain_store` call with:
- `client_id`: resolved from extraction
- `knowledge_category`: `meeting`
- `content`: the key takeaway or action item

### 5. Import/Export

**Export** — `GET /memory/export`
- Query params: `client_id` (optional), `type` (optional), `since` (optional ISO timestamp), `active_only` (default true)
- Scrolls all Qdrant points using paginated scroll (100 per page, follows `next_page_offset` until exhausted)
- Returns JSON array of full payloads (no vectors — regenerated on import)
- Export includes ALL type-specific fields: `key` (facts), `subject` (statuses), plus common fields
- `confidence` is the base stored value, not the decayed effective value
- Format:
```json
[
  {
    "id": "uuid",
    "content": "...",
    "type": "fact",
    "key": "seo-strategy-acme-loans",
    "subject": null,
    "client_id": "acme-loans",
    "knowledge_category": "strategy",
    "category": "semantic",
    "source_agent": "claude-code",
    "importance": "high",
    "confidence": 1.0,
    "access_count": 3,
    "active": true,
    "superseded_by": null,
    "entities": [{"name": "Acme Loans", "type": "client"}],
    "created_at": "2026-03-20T...",
    "last_accessed_at": "2026-03-20T..."
  }
]
```

**Import** — `POST /memory/import`
- Accepts JSON array in same format
- Maximum 500 records per request (return 400 if exceeded)
- Processing is sequential with 100ms delay between batches of 10 (rate-limit protection for embedding API)
- For each record:
  1. Check content_hash — skip if duplicate exists
  2. Embed with current provider (using `purpose: 'store'`)
  3. Upsert to Qdrant with original payload + new vector
  4. Write to structured store
- Response: `{ imported: N, skipped: N, errors: N }`

**MCP tools**: `brain_export(client_id?, type?, since?)` and `brain_import(data)`

**Nightly backup** — n8n scheduled workflow (owned by n8n workflow builder, not API code):
- Runs daily at 3 AM
- Calls `GET /memory/export`
- Saves to `E:\Backups\shared-brain\YYYY-MM-DD.json`
- Prunes exports older than 30 days

### 6. Auto-Capture & Real-Time Notifications

**Auto-capture** — minimal to start, expand based on signal-to-noise:

- **Session summaries**: Already implemented via `/sessionend` skill. No change.
- **n8n workflow events**: Already wired (64 error + 8 success flows). No change.
- **Client file hook** (new): Claude Code hook (configured in `settings.json` as a `PostToolUse` hook) that runs a shell script after file writes. The script checks if the modified path is under `E:\Clients\{name}\` and if so, curls the Shared Brain API with a brief memory: `"Updated {filename} for {client_id}"` with `knowledge_category` inferred from path (e.g., `seo/` → `technical`, `meetings/` → `meeting`). This is a Claude Code settings hook, not a filesystem watcher.
- **Git commit capture** (new): Standard git `post-commit` hook in client repos. Runs a shell script that extracts commit message + changed files and curls the Shared Brain API to store as an event. No LLM needed.

**Real-time notifications** — webhook dispatch:

When a memory is stored, superseded, or deleted, the API fires webhooks to registered URLs. Dispatch points:
- `memory_stored`: fires from `POST /memory` and `POST /memory/import`
- `memory_superseded`: fires from `POST /memory` (when a fact/status supersedes an older entry) and from consolidation (when merging)
- `memory_deleted`: fires from `DELETE /memory/:id`

**Config** (`.env`):
```
WEBHOOK_NOTIFY_URLS=http://n8n.local:5678/webhook/brain-event
```

**Payload**:
```json
{
  "event": "memory_stored",
  "memory": {
    "id": "uuid",
    "type": "fact",
    "client_id": "acme-loans",
    "knowledge_category": "strategy",
    "content_preview": "First 200 chars...",
    "source_agent": "claude-code",
    "importance": "high",
    "created_at": "2026-03-20T..."
  }
}
```

**Fire-and-forget**: Webhook failures are logged but never block the store operation. No retries — if the listener is down, it catches up via briefing.

**Events dispatched**: `memory_stored`, `memory_superseded`, `memory_deleted`

### 7. Entity Graph

**Relationship tracking**:

New `entity_relationships` table in structured store:
```sql
CREATE TABLE entity_relationships (
  id SERIAL PRIMARY KEY,
  source_entity_id INTEGER REFERENCES entities(id),
  target_entity_id INTEGER REFERENCES entities(id),
  relationship_type TEXT NOT NULL, -- 'contact_of', 'same_owner', 'uses', 'works_on', 'competitor_of'
  strength INTEGER DEFAULT 1, -- co-occurrence count
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(source_entity_id, target_entity_id, relationship_type)
);
```

**Relationship detection**:
- **Co-occurrence**: When two entities appear in the same memory, create or increment their relationship strength. First co-occurrence creates the row with `strength=1`, subsequent co-occurrences increment by 1 via `ON CONFLICT ... SET strength = strength + 1`
- **Consolidation refinement**: LLM classifies relationship types during 6h consolidation pass
- **Manual override**: `brain_graph` tool can accept explicit relationship additions

**`brain_graph` MCP tool**:
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `entity` | string | yes | Entity name to explore |
| `depth` | number | no | Relationship traversal depth (default 1, max 3) |
| `min_strength` | number | no | Minimum relationship strength to include (default 2) |

Returns connected entities with relationship types and strengths.

**HTML visualization** — `GET /memory/graph/:entity/html` (API endpoint only):

The `brain_graph` MCP tool returns JSON data (entity + relationships). For the HTML visualization, agents return the URL to the API endpoint (`http://{host}:{port}/memory/graph/{entity}/html`) rather than embedding HTML in MCP responses. The HTML page is also accessible directly via browser.

Interactive force-directed graph using D3.js. Design goals:
- Dark theme, premium feel — this is a marketing showpiece
- Nodes colored by entity type (clients = teal, people = amber, tech = blue, workflows = purple)
- Node size scales with mention_count
- Edge thickness scales with relationship strength
- Click a node to see its connections highlighted + recent memories in a side panel
- Smooth physics-based animation, zoom/pan, search
- Export as PNG for presentations
- Standalone HTML file — no server needed to view, shareable

## New MCP Tools Summary

| Tool | Purpose |
|------|---------|
| `brain_client` | Client briefing + filtered search with fuzzy name resolution |
| `brain_export` | Export memories as JSON (backup, migration) |
| `brain_import` | Import memories from JSON (restore, migration) |
| `brain_graph` | Query entity relationships + generate visualization |

Total tools: 11 (7 existing + 4 new)

## New API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /client/:clientId` | Client knowledge briefing |
| `GET /client/fingerprints` | Fetch all client fingerprints (for Fireflies/workflows) |
| `GET /export` | Export memories as JSON |
| `POST /export/import` | Import memories from JSON |
| `GET /graph/:entity` | Entity graph query |
| `GET /graph/:entity/html` | Interactive graph visualization |

## Files Changed/Created

**New files**:
- `api/src/services/client-resolver.js` — fingerprint cache + resolver
- `api/src/routes/client.js` — client endpoints (briefing, fingerprints)
- `api/src/routes/export.js` — import/export endpoints
- `api/src/routes/graph.js` — entity graph endpoints + HTML generator
- `api/src/services/notifications.js` — webhook dispatch
- `api/src/templates/graph.html` — D3.js visualization template

**Modified files**:
- `api/src/routes/memory.js` — auto-resolve client_id, knowledge_category field, webhook dispatch
- `api/src/services/consolidation.js` — reclassify knowledge_category, relationship detection
- `api/src/services/entities.js` — co-occurrence tracking, relationship CRUD
- `api/src/services/stores/*.js` — knowledge_category column, entity_relationships table
- `mcp-server/src/index.js` — 4 new tools
- `.env.example` — new config vars

## Prerequisites

- **Dual store required**: The entity graph (section 7) requires SQLite or Postgres for the `entity_relationships` table. Client fingerprints (section 1) require Baserow for table 734. Production deployment needs both Postgres AND Baserow active (which is the current Beelink setup). SQLite-only deployments get everything except fingerprint auto-fetch (must configure fingerprints via env var or local JSON file as fallback).
- **Entity name URL encoding**: API routes using entity names as path parameters (`/memory/graph/:entity`) must handle URL-encoded names. Entity names can contain spaces and special characters ("Expert Local", "Node.js"). The MCP tool passes entity names as string parameters (no URL encoding needed).

## Non-Goals

- Web dashboard UI (agents are the interface)
- Python SDK (defer — curl/MCP covers all current consumers)
- Multi-collection support (revisit at 20-30+ clients)
- Full transcript storage (only key takeaways and action items)

## Migration

- **Zero breaking changes**: All existing memories, tools, and flows continue working
- **knowledge_category**: null treated as `general` everywhere
- **Fingerprints**: Populated manually in Baserow 734 for 5 active clients at launch
- **entity_relationships table**: Created on startup (idempotent migration)
- **Existing entities**: Backfill relationships from co-occurrence in current memories (one-time script)
