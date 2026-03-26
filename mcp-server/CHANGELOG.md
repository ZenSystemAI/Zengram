# Changelog

## 2.3.0 (2026-03-26)

### Multi-Path Retrieval with RRF Fusion

Search now runs three retrieval paths in parallel and merges results using Reciprocal Rank Fusion — dramatically improving recall for exact names, technical terms, and entity-connected memories.

#### New Retrieval Paths
- **BM25 keyword search** — Full-text search via Postgres tsvector/GIN index or SQLite FTS5 fallback. Catches exact term matches that embedding similarity misses (client names, technical terms, error codes).
- **Entity graph BFS retrieval** — Breadth-first spreading activation through the entity relationship graph. Starts from entities mentioned in the query, traverses co-occurrence and typed relationships (uses, works_on, contact_of) with configurable activation decay. Surfaces memories connected by entity relationships, not just text similarity.
- **Reciprocal Rank Fusion (RRF)** — Merges ranked lists from all three paths using `score(d) = sum(1/(k+rank))`. Items found by multiple paths get boosted. Pure JS, zero dependencies.

#### New Files
- `api/src/services/rrf.js` — RRF fusion algorithm with 13 unit tests
- `api/src/services/keyword-search.js` — BM25/FTS keyword search service
- `api/src/services/graph-search.js` — BFS spreading activation graph retrieval
- `api/scripts/backfill-keyword-index.js` — One-time migration for existing memories
- `api/tests/rrf.test.js` — Comprehensive test suite (edge cases, score verification, 3-path scenarios)

#### API Changes
- `GET /memory/search` runs all 3 paths via `Promise.all()`, fuses with RRF
- `format=full` results include `retrieval_sources` array showing which paths contributed (e.g. `["vector", "keyword", "graph"]`)
- `format=full` response includes `retrieval` metadata with per-path hit counts
- `POST /memory` indexes content for keyword search on write (fire-and-forget)
- `DELETE /memory/:id` and supersede logic deactivate keyword index entries
- `GET /stats` includes `retrieval` section with keyword index count and path availability

#### MCP Tool Updates
- `brain_search` description updated to reflect multi-path retrieval

#### Schema Changes
- **Postgres**: `memory_search` table with tsvector column, GIN index, auto-compute trigger. Partial indexes on `entity_relationships` for co-occurrence lookups.
- **SQLite**: FTS5 virtual table `memory_search_fts` for keyword search fallback.
- **Qdrant**: `getPoints()` batch retrieval endpoint for RRF payload hydration.

#### Configuration
- `MULTI_PATH_SEARCH=true|false` — Feature flag (default: true)
- `RRF_K=60` — RRF smoothing constant (range 50-100)
- `GRAPH_SEARCH_MAX_DEPTH=2` — Max BFS hops through entity graph
- `GRAPH_SEARCH_DECAY=0.8` — Activation decay per hop
- `GRAPH_SEARCH_CAUSAL_BOOST=2.0` — Boost for typed relationships vs co_occurrence

#### Testing
- 13 new RRF unit tests, 114 total tests passing

Inspired by [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)'s 4-way parallel search architecture.

## 2.0.0 (2026-03-20)

### Features
- **Client knowledge base**: Fingerprint-based client identification with accent normalization, `knowledge_category` field (brand/strategy/meeting/content/technical/relationship/general), `brain_client` tool for one-call client briefings with fuzzy name resolution
- **Import/Export**: `brain_export` and `brain_import` tools for backup and embedding migration safety, with dedup and batch processing
- **Webhook notifications**: Real-time dispatch on memory store/supersede/delete events via configurable webhook URLs
- **Entity graph**: Relationship tracking with co-occurrence detection, `brain_graph` tool, interactive D3.js visualization (dark theme, force-directed, searchable)
- **Consolidation enhancements**: Automatic knowledge_category reclassification and entity relationship type classification during 6h consolidation pass
- **Auto-resolve client_id**: Memory store auto-tags client_id from content using fingerprint matching when not explicitly provided
- **Gemini Embedding 2**: New pluggable embedder with task-type-aware embeddings (RETRIEVAL_DOCUMENT/RETRIEVAL_QUERY), Matryoshka support (3072/1536/768 dims)

## 1.5.0

### Long-Term Memory Hygiene
- **Access-weighted search** — search results factor in access count alongside similarity and confidence, rewarding frequently-accessed memories
- **Insight removal** — consolidation-generated insights can now be removed when source memories are deleted
- **Entity fix** — fixed entity extraction for memories with no client_id

## 1.4.0

### Token Optimization
- **Compact response format** — `brain_briefing` and `brain_search` now default to `compact` mode: content truncated to 200 chars, low-importance events filtered, essential fields only. **~70-80% token reduction** on typical briefings.
- **Summary format** — `format=summary` returns counts + one-line headlines only for minimal token usage (~90% reduction).
- **Full format preserved** — `format=full` restores original verbose behavior when complete content is needed.
- **Importance-ranked sorting** — briefing results sort by importance (critical/high first) then recency, so agents see what matters first.

### Security
- **Prompt injection hardening** — consolidation engine now applies full XML entity escaping (`&`, `<`, `>`, `"`, `'`) on all user content and payload attributes. JSON code-fence stripping handles LLMs that wrap output in markdown. Top-level structure validation rejects non-object responses.

### Performance
- **O(1) supersedes lookup** — fact/status supersede checks now query Qdrant by `key`/`subject` field directly instead of scanning all active records. New payload indexes for `key` and `subject`.
- **Async consolidation** — `POST /consolidate` returns a job ID immediately (HTTP 202). Poll status via `GET /consolidate/job/:id`. Jobs auto-expire after 1 hour. Backward-compatible: `?sync=true` preserves blocking behavior.
- **Briefing pagination** — `limit` parameter (1-500, default 100) prevents unbounded responses.

### New Features
- **Memory deletion** — `DELETE /memory/:id` soft-deletes a memory (marks inactive). Agent-scoped keys can only delete their own memories. Audit fields: `deleted_at`, `deleted_by`, `deletion_reason`. Exposed via `brain_delete` MCP tool.
- **Request correlation IDs** — every request gets an `X-Request-ID` header (generated or propagated) for cross-service tracing.
- **Configurable MCP timeouts** — `BRAIN_MCP_TIMEOUT` (default 15s) and `BRAIN_MCP_CONSOLIDATION_TIMEOUT` (default 120s) environment variables.

### Reliability
- **Graceful shutdown** — API server handles SIGTERM/SIGINT, drains in-flight connections, force-exits after 10s timeout.
- **Alias cache cold-start fix** — 67 built-in KNOWN_TECH aliases pre-seeded on startup so technology entities resolve immediately, even before first consolidation run.
- **Entity name normalization** — consolidation normalizes canonical names (trim, collapse whitespace) and uses case-insensitive lookup to prevent duplicate entities like "Acme Corp" vs "acme corp".
- **SQLite error logging** — silent catch blocks now only suppress genuine UNIQUE constraint duplicates; real errors (disk full, permission denied) are logged at WARN level.

### Testing
- **41 new tests** — validation middleware (23 tests: type, content, source_agent, importance, metadata, string fields, composite) and entity extraction (18 tests: basic, technologies, domains, quoted names, capitalized phrases, alias cache, dedup, cold-start).
- **81 total tests**, all passing.

### Indexes
- New Qdrant payload indexes: `key` (Keyword), `subject` (Keyword) — created on startup for existing collections.

## 1.2.0

### Entity Extraction & Linking
- **Automatic entity extraction** — memories extract entities (clients, technologies, workflows, people, domains, agents) at storage time using fast regex + known-tech dictionary. No LLM call, non-blocking (fire-and-forget).
- **Entity graph** — new `entities`, `entity_aliases`, and `entity_memory_links` tables in SQLite/Postgres. Alias resolution enables canonical entity deduplication.
- **LLM entity refinement** — consolidation engine discovers entities regex missed, normalizes aliases, classifies types. Alias cache refreshes after each run for compounding accuracy.
- **Qdrant native entity filtering** — `entities[].name` payload index enables entity-scoped vector search with no result-count ceiling. `GET /memory/search?entity=Docker` filters at the Qdrant level.
- **Shared `linkExtractedEntities`** — single function for entity find-or-create-then-link, used by memory store, webhook, and backfill.
- **New `brain_entities` MCP tool** — list, get, memories, stats actions for the entity graph.
- **New API endpoints** — `GET /entities`, `GET /entities/stats`, `GET /entities/:name`, `GET /entities/:name/memories`.
- **Briefing entity summary** — `GET /briefing` includes `entities_mentioned` in summary.
- **Stats entity counts** — `GET /stats` includes entity breakdown by type and top-mentioned.
- **Backfill script** — `api/scripts/backfill-entities.js` extracts entities from all existing memories.

### Bug Fixes
- **Fixed `scrollPoints` filter bug** — boolean `false` values (e.g. `{consolidated: false}`) were silently dropped, causing consolidation to reprocess all memories instead of only unconsolidated ones.
- **Fixed Postgres `createEntity` race condition** — concurrent inserts for the same entity now use `ON CONFLICT` upsert instead of SELECT-then-INSERT.
- **Fixed `brain_entities` validation** — `get` and `memories` actions now return an error when `name` is missing instead of silently falling through to `list`.
- **Removed user input echo from error responses** — 404/400 errors no longer reflect request parameters.

## 1.1.0

- Consolidation dedup: exact hash + 92% semantic similarity
- Gemini 2.5 Flash consolidation provider
- Webhook deduplication
- Event TTL auto-cleanup (configurable, default 30 days)
- Docker health check fixes

## 1.0.2

- Expanded npm keywords for better discoverability
- Improved package description
- Added Qdrant request timeout (default 10s, configurable via `QDRANT_TIMEOUT_MS`)
- Webhook now surfaces structured store warnings instead of silently swallowing errors
- Added troubleshooting section to README
- Added `brain_consolidate` and `brain_stats` usage examples to README
- CI now validates MCP server entrypoint
- Version alignment between package.json and MCP server registration

## 1.0.1

- Initial npm publish with README

## 1.0.0

- Initial release
