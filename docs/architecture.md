# System Architecture

Zengram is a multi-agent memory system that enables AI agents (Claude Code and other callers) to share persistent knowledge through a unified API. Memories are stored as vectors in Postgres via pgvector, indexed for full-text search, linked to extracted entities, and consolidated by an LLM on a schedule.

## High-Level Architecture

```mermaid
graph TB
    subgraph Clients
        CC[Claude Code<br>MCP Client]
        HTTP[Any HTTP Client]
    end

    subgraph MCP["MCP Server (stdio)"]
        MCP_S[mcp-server/src/index.js<br>12 tools, JSON-RPC over stdio]
    end

    subgraph API["Express API (:8084)"]
        AUTH[Auth Middleware<br>single admin API key]
        RL[Rate Limiter<br>per-key bucketed]
        ROUTES[Route Handlers]
        EMBED[Embedding Interface<br>OpenAI / Gemini / Ollama]
        LLM_I[LLM Interface<br>OpenAI / Anthropic / Gemini / Ollama]
        ENT[Entity Extractor<br>regex + alias cache]
        KW[Keyword Search<br>BM25 via tsvector]
        RRF[RRF Fusion<br>reciprocal rank merge]
        CONS[Consolidation Engine<br>LLM-driven merge/dedup]
        SCRUB[Credential Scrubber]
    end

    subgraph Storage
        PG[(Postgres<br>pgvector + structured tables)]
    end

    CC -->|stdio| MCP_S
    MCP_S -->|HTTP + x-api-key| AUTH
    HTTP -->|HTTP + x-api-key| AUTH

    AUTH --> RL --> ROUTES
    ROUTES --> EMBED --> PG
    ROUTES --> ENT --> PG
    ROUTES --> KW --> PG
    ROUTES --> RRF
    CONS --> LLM_I
    CONS --> PG
    ROUTES --> SCRUB
```

## Startup Sequence

Defined in `api/src/index.js`:

1. **Validate environment** -- `BRAIN_API_KEY` required or fatal exit
2. **Initialize embedding provider** -- OpenAI, Gemini, or Ollama (test embed validates connectivity; its dimensions size the vector column)
3. **Initialize pgvector** -- Ensure the `pgvector` extension, vector column, and HNSW + entity indexes exist
4. **Initialize structured store** -- Postgres (the only supported backend)
5. **Initialize keyword search** -- BM25 via Postgres `tsvector` with a GIN index
6. **Load entity alias cache** -- Pre-populates in-memory alias map from the structured store + built-in tech dict
7. **Initialize consolidation LLM** (if enabled) -- Sets up cron schedule (default: every 6 hours)
8. **Start Express server** -- Binds to `HOST:PORT` (default `127.0.0.1:8084`)
9. **Register graceful shutdown** -- SIGTERM/SIGINT handlers with 10s forced exit timeout

## Component Inventory

### Routes (`api/src/routes/`)

| File | Mount | Purpose |
|------|-------|---------|
| `memory.js` | `/memory` | Store, search (multi-path), query, update, delete memories |
| `briefing.js` | `/briefing` | Session briefings: what happened since timestamp |
| `stats.js` | `/stats` | Memory health dashboard: counts, decay, retrieval status |
| `entities.js` | `/entities` | Entity listing, lookup, linked memories, reclassification |
| `export.js` | `/export` | Export/import memories as JSON (backup/migration) |
| `consolidation.js` | `/consolidate` | Trigger consolidation, poll jobs, check status |
| `reflect.js` | `/reflect` | LLM-powered topic synthesis across memories |
| `collections.js` | `/collections` | Multi-collection management |

### Services (`api/src/services/`)

| File | Purpose |
|------|---------|
| `pgvector.js` | Postgres pgvector client: upsert, vector search, scroll, batch ops, decay computation |
| `consolidation.js` | LLM consolidation pipeline: merge, contradictions, entities, relationships |
| `entities.js` | Regex + alias-cache entity extraction, reclassification, linking |
| `rrf.js` | Reciprocal Rank Fusion: merges vector + keyword result lists |
| `keyword-search.js` | BM25 full-text search via Postgres tsvector |
| `query-expander.js` | Query expansion for improved recall |
| `relevance-scorer.js` | Confidence decay + access-boost scoring on results |
| `temporal-resolver.js` | Resolves relative time references for `at_time` queries |
| `collection-registry.js` | Tracks and manages memory collections |
| `scrub.js` | Credential scrubbing from memory content |
| `fetch-with-timeout.js` | Fetch wrapper with configurable timeout |

### Embedding Providers (`api/src/services/embedders/`)

| File | Provider | Model/Dims |
|------|----------|------------|
| `interface.js` | Router | Selects provider by `EMBEDDING_PROVIDER` env var |
| `openai.js` | OpenAI | `text-embedding-3-small` (1536 dims) |
| `gemini.js` | Gemini | `gemini-embedding-2-preview` (3072 dims, Matryoshka) |
| `ollama.js` | Ollama | Auto-detected from model (e.g. `nomic-embed-text`) |

Gemini uses task-specific embeddings: `RETRIEVAL_DOCUMENT` for storage, `RETRIEVAL_QUERY` for search.

### LLM Providers (`api/src/services/llm/`)

| File | Provider | Used For |
|------|----------|----------|
| `interface.js` | Router | Selects by `CONSOLIDATION_LLM` env var |
| `openai.js` | OpenAI | Consolidation + reflection (default: `gpt-4o-mini`) |
| `anthropic.js` | Anthropic | Consolidation + reflection |
| `gemini.js` | Gemini | Consolidation + reflection |
| `ollama.js` | Ollama | Consolidation + reflection (local) |

### Structured Store Backends (`api/src/services/stores/`)

| File | Backend | Features |
|------|---------|----------|
| `interface.js` | Router | Selects by `STRUCTURED_STORE` env var; only `postgres` is supported (throws otherwise) |
| `postgres.js` | Postgres | Events, facts, statuses, entities, aliases, relationships + tsvector GIN index for full BM25 |

### Middleware (`api/src/middleware/`)

| File | Purpose |
|------|---------|
| `auth.js` | API key auth: single admin key (full access), failed-attempt IP throttling, timing-safe compare |
| `ratelimit.js` | Per-key bucketed rate limiting: writes 60/min, reads 120/min, consolidation 1/hr |
| `validate.js` | Input validation: type, content (max 10K chars), agent names, metadata depth |

### MCP Server (`mcp-server/src/`)

| File | Purpose |
|------|---------|
| `index.js` | MCP server with 12 tools, stdio transport, wraps API calls with timeouts |

## Data Flow: Store Path

```mermaid
sequenceDiagram
    participant A as Agent
    participant API as Express API
    participant S as Scrubber
    participant V as Validator
    participant D as Dedup Check
    participant E as Embedder
    participant Q as pgvector
    participant KW as Keyword Index
    participant ENT as Entity Extractor
    participant SQL as Structured Store

    A->>API: POST /memory {type, content, source_agent, ...}
    API->>V: Validate all fields
    API->>S: scrubCredentials(content)
    API->>D: SHA256 hash -> findByPayload(content_hash)
    alt Duplicate found
        D-->>API: Return existing ID (dedup)
    end
    API->>E: embed(content, 'store')
    E-->>API: vector[]
    API->>Q: upsertPoint(id, vector, payload)
    API-->>A: 201 {id, content_hash, ...}
    API--)KW: indexMemory (fire-and-forget)
    API--)ENT: extractEntities + linkExtractedEntities (fire-and-forget)
    API--)SQL: createEvent/upsertFact/upsertStatus (fire-and-forget)
```

Key behaviors:
- **Deduplication** is tenant-scoped: checks `content_hash` + `client_id` + `type` + `active=true`
- **Same agent duplicate**: returns existing memory ID silently
- **Different agent duplicate**: records cross-agent corroboration (bumps `observed_by` list, capped at 20)
- **Supersedes logic**: facts with matching `key` or statuses with matching `subject` deactivate the old version
- **Entity extraction** is LLM-free: uses regex patterns, known tech dictionary (70+ entries), capitalized phrase detection, and an alias cache

## Data Flow: Search Path (Multi-Path Retrieval)

```mermaid
sequenceDiagram
    participant A as Agent
    participant API as Express API
    participant E as Embedder
    participant Q as pgvector (Vector)
    participant KW as Keyword (BM25)
    participant RRF as RRF Fusion

    A->>API: GET /memory/search?q=...
    par Two parallel paths
        API->>E: embed(q, 'search')
        E->>Q: searchPoints(vector, filter)
    and
        API->>KW: keywordSearch(q, filter)
    end
    Q-->>RRF: [{id, score}]
    KW-->>RRF: [{memory_id, rank}]
    RRF->>RRF: reciprocalRankFusion(rankedLists, k=60)
    RRF-->>API: [{id, rrf_score, sources}]
    API->>API: Apply confidence decay + access boost
    API-->>A: {results: [...]}
```

The two retrieval paths run in parallel:
1. **Vector search** (pgvector cosine similarity, score threshold 0.3)
2. **Keyword search** (BM25 via Postgres `ts_rank_cd`)

Results are fused using **Reciprocal Rank Fusion**: `score(d) = sum(1 / (k + rank))` where k=60 (configurable via `RRF_K`).

## Data Flow: Consolidation Path

```mermaid
sequenceDiagram
    participant CRON as Cron Schedule
    participant C as Consolidation Engine
    participant Q as pgvector
    participant LLM as LLM Provider
    participant SQL as Entity Store

    CRON->>C: runConsolidation()
    C->>Q: scrollPoints({consolidated: false}) [paginated]
    Q-->>C: All unconsolidated points
    C->>C: Group by client_id
    loop Each batch of 50
        C->>LLM: Analyze memories (XML-wrapped)
        LLM-->>C: {merged_facts, contradictions, connections, entities, knowledge_categories, entity_relationship_types}
        C->>C: Validate: strip out-of-batch IDs, check types
        C->>Q: Store merged facts (with semantic dedup check)
        C->>Q: Mark source memories inactive (superseded)
        C->>Q: Store contradictions as high-importance events
        C->>Q: Update connection metadata on existing points
        C->>SQL: Create/update entities + aliases
        C->>SQL: Link entities to memories
        C->>SQL: Create entity relationships
        C->>Q: Reclassify knowledge_categories
        C->>Q: Mark batch as consolidated
    end
    C->>C: cleanupOldEvents (>30d, never accessed, medium/low)
    C->>SQL: Refresh alias cache
```

## Vector Payload Schema

Memories table: `shared_memories` (pgvector embedding column + indexed payload fields)

| Field | Index Type | Purpose |
|-------|-----------|---------|
| `type` | Keyword | Filter by memory type (event/fact/decision/status) |
| `source_agent` | Keyword | Filter by originating agent |
| `client_id` | Keyword | Tenant isolation |
| `category` | Keyword | semantic/episodic/procedural |
| `importance` | Keyword | critical/high/medium/low |
| `content_hash` | Keyword | SHA256 truncated to 16 chars, for dedup lookups |
| `key` | Keyword | Fact upsert key (supersedes matching) |
| `subject` | Keyword | Status subject (supersedes matching) |
| `knowledge_category` | Keyword | brand/strategy/meeting/content/technical/relationship/general |
| `active` | Bool | Soft-delete filter (true = visible in search) |
| `confidence` | Float | Base confidence (used with decay) |
| `access_count` | Integer | How often this memory has been retrieved |
| `created_at` | Datetime | Creation timestamp |
| `last_accessed_at` | Datetime | Last retrieval timestamp (for decay) |
| `entities[].name` | Keyword (nested) | Entity name filter for entity-scoped search |

Vector config: Cosine distance, dimensions set dynamically from embedding provider. Indexing threshold: 100.

## Structured Store Tables

Tables created by the Postgres backend:

| Table | Columns | Purpose |
|-------|---------|---------|
| `events` | id, content, type, source_agent, client_id, category, importance, knowledge_category, content_hash, created_at | Append-only event log |
| `facts` | id, key, value, source_agent, client_id, category, importance, created_at, updated_at | Upsertable facts by key |
| `statuses` | id, subject, status, source_agent, client_id, category, created_at, updated_at | Current state by subject |
| `entities` | id, canonical_name, entity_type, first_seen, last_seen, mention_count | Knowledge graph nodes |
| `entity_aliases` | id, entity_id, alias | Alternative names for entities |
| `entity_memory_links` | id, entity_id, memory_id, role, linked_at | Entity-to-memory edges |
| `entity_relationships` | id, source_entity_id, target_entity_id, relationship_type, strength, first_seen, last_seen | Entity-to-entity edges |
| `memory_search` | memory_id, content, content_tsv, client_id, source_agent, type, active | BM25 full-text with GIN index |

## Docker Deployment

Defined in `docker-compose.yml`:

| Container | Image | Ports | Volumes |
|-----------|-------|-------|---------|
| `zengram-api` | Built from `./api` | 8084:8084 | `./data` |
| `zengram-postgres` | `pgvector/pgvector:pg16` | 5433:5432 | `./data/postgres` |

All ports bind to `127.0.0.1` by default for security. Set `API_BIND=0.0.0.0` for LAN access.

## Cross-References

- [Operations Runbook](operations.md) -- deployment, monitoring, failure modes
- [API Reference](api-reference.md) -- every endpoint with request/response schemas
- [Data Model](data-model.md) -- memory types, decay, dedup, supersedes logic
- [MCP Tools](mcp-tools.md) -- the 12 MCP tools agents use
- [Configuration](configuration.md) -- every environment variable
