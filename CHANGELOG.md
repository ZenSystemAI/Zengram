# Changelog

This changelog covers the entire Zengram project (API, MCP server, adapters, and tooling).

This root file is the canonical changelog for the project. The `mcp-server/CHANGELOG.md` tracks only the published `@zensystemai/zengram-mcp` package history.

## 4.2.0 (2026-06-12)

Cleanup and hardening release — docs realigned to the v4 surface, retrieval/consolidation bug fixes, security defaults, and dependency/CI hygiene. No breaking API changes.

### Fixed
- **`at_time` search** no longer drops events/decisions from the vector path — the `valid_from` range filter is now NULL-tolerant, so the vector and keyword paths agree.
- **Fact/status supersede** is now atomic: the find-deactivate-insert runs in one transaction under a per-key advisory lock, so concurrent writes can't leave two active rows for the same key/subject.
- **Consolidation** no longer dedupes a merged fact against its own source memories (which silently dropped good merges); sources are excluded from the semantic-dedup check.
- **Temporal resolver** `today` / `this week|month|year` / `recently` now use an end-of-day upper bound, fixing empty windows when a date-only reference date is supplied.

### Security
- API key is accepted from the `x-api-key` header only (the query-string `?key=` path was removed — it leaked the key into logs and bypassed the rate limiter).
- Credentials are scrubbed before embedding on every consolidation write path (merged facts, summaries, contradictions), restoring the documented scrub-before-embed invariant.
- The server fails fast when `POSTGRES_URL` is unset, and the committed default database credentials were removed from the source fallbacks.
- The entity-reclassification audit log no longer makes an authenticated self-HTTP call.
- The bundled entity dictionary ships generic example names only.

### Performance
- Search access-count updates are now a single atomic SQL increment instead of one read plus N writes (also closes the read-modify-write race).

### Changed
- `node-cron` upgraded to 4.x, clearing a moderate `uuid` advisory and removing its transitive dependencies.
- `npm ci` is used for all installs (Docker, CI, publish); the npm publish dedupe guard now checks the correct package name.
- Added a lenient `checkJs` typecheck (non-blocking in CI) and request-id correlation in error logs.

### Added
- Unit tests for the temporal resolver.
- A retrieval-quality evaluation harness skeleton (`api/scripts/eval/`, `docs/eval-harness.md`).

### Docs
- README, CLAUDE.md, CONTRIBUTING, `docs/*`, and the examples were realigned to the v4 reality: Postgres + pgvector (no Qdrant), 8 routes, 12 MCP tools, Postgres-only structured store (no SQLite/Baserow), and no Python/TypeScript SDK.

## 4.1.0 (unreleased) — v4 Cleanup Sweep

Post-4.0.0 hardening and dead-code removal. No new product surface; the API, MCP tools, and storage model are unchanged from 4.0.0. Both `package.json` files declare `4.1.0`.

### Removed
- **Dead scripts, backends, and MCP tools.** Finished the v4 sweep: removed remaining legacy scripts, the non-Postgres structured-store backends, and orphaned MCP tool definitions. `STRUCTURED_STORE` now supports `postgres` only (`initStore()` throws otherwise).
- **Dead exports and shim functions.** Pruned unused exports and compatibility shims left over from the v3 surface.

### Changed
- **Stopped hiding real failures behind defensive try/catch.** Error handling no longer swallows genuine errors; failures surface instead of being silently downgraded.
- **DRY extractions.** Factored out shared helpers (`contentHash`, `requirePoint`, `requireEntityStore`, `storeConsolidatedFact`) to remove duplication across routes and services.

### Fixed
- **Input-validation gaps closed** and duplicated enum literals de-duplicated in the validation middleware.

### Docs
- Scrubbed migration residue and trimmed narration noise from inline comments.

## 4.0.0 (2026-04-11) — Shared Brain, Slimmed

Variant A from the v4 redesign assessment. The architectural ideas (hybrid retrieval, typed memories, confidence-gated NER, LLM consolidation, credential scrubbing, MCP surface) are unchanged. The multi-agent coordination layer and the visual-graph features built for É-Marketing demos are gone.

### Removed
- **Per-agent identity system.** `ti-claude`, `mini-claude`, `morpheus`, `neo`, `autolab`, `n8n` retired. One canonical `source_agent: "claude-code"` — all writes coerced regardless of caller. Auth middleware no longer binds `req.authenticatedAgent`; only a single admin API key (`BRAIN_API_KEY`) authenticates requests. See `scripts/v4-migrate-source-agent.sql` to backfill historical Postgres rows.
- **Graph BFS retrieval path.** `services/graph-search.js` and the graph contribution to `/memory/search` and `/reflect` removed. Hybrid retrieval is now vector + BM25 only. The `entities` table, alias cache, and entity-memory links are still maintained for coreference and stats.
- **Graph visualization.** `/graph/html`, `/graph/full/html`, `/graph/:entity/html`, `/graph/:entity` JSON routes, their D3.js template, the browseable entity-index template, and the entity-reclassify-suggestions endpoint removed.
- **Dead route files.** `/dashboard`, `/subscribe`, `/webhook`, `/reconcile`, `/client` — none had active callers.
- **Dormant adapters.** `adapters/openclaw/` (465 LOC, 0 active writers) and `adapters/n8n/` (95 LOC, 0 active writers) deleted.
- **Unused SDKs.** `sdk/python/` and `sdk/typescript/` (~5,000 LOC combined, zero external consumers — MCP server is the only integration path in practice).
- **Dead services.** `event-bus.js`, `feedback-loop.js`, `notifications.js`, `client-resolver.js`, `entity-type-heuristics.js` removed.

### Changed
- **Consolidation gated by corpus size.** Scheduled runs skip if active corpus < `CONSOLIDATION_MIN_CORPUS` (default 1500). Manual `POST /consolidate` always runs. At the current 500-memory scale, scheduled consolidations were running every 6h with almost no work — wasted LLM calls.
- **CLAUDE.md + docs/configuration.md** rewritten for the v4 surface. Removed per-agent key table, Baserow store section, webhook/graph sections.
- **.env.example** simplified; removed `AGENT_KEY_*`, graph tuning vars, webhook vars, client-resolver vars. Added `CONSOLIDATION_MIN_CORPUS`.

### Deferred (still on the roadmap)
- **Qdrant → pgvector migration.** The biggest single piece of Variant A, needs a DB backup + deploy window. Not touched tonight. Left Qdrant as the vector store; everything else cuts through without it.

### Companion change outside this repo
- **Admin UI**: Removed the Brain Graph tab from `js/views/memory.js` (it embedded the deleted `/graph/full/html` iframe). Fixed a stale `BRAIN_URL` pointer that targeted the wrong host on the local network.

### Deleted tests
- `tests/client-resolver.test.js` and `tests/notifications.test.js` (modules they covered no longer exist). 104 unit tests still pass.

## 2.4.0 (2026-03-28)

### New Features
- **brain_reflect** — On-demand LLM synthesis across memories. Given a topic, searches relevant memories via multi-path retrieval and uses the LLM to identify patterns, timeline evolution, contradictions, and knowledge gaps. New MCP tool + `POST /reflect` API endpoint.
- **brain_update** — Partial memory amendment without full supersede. Agents can update content, importance, knowledge_category, or metadata on existing memories. Content changes trigger re-embed, re-extract entities, and re-index. New MCP tool + `PATCH /memory/:id` API endpoint.
- **Temporal validity** — Facts and statuses now support `valid_from` and `valid_to` timestamps, enabling "what was true at time X?" queries. Auto-sets `valid_to` on superseded memories. New `at_time` parameter on `brain_search`.

### Bug Fixes
- **Consolidation pagination** (P1): `runConsolidation()` and `cleanupOldEvents()` now paginate through ALL Qdrant points instead of only processing the first 200. Memories beyond the first page were silently missed.
- **Briefing pagination** (P1): Session briefings now paginate through all matching events instead of truncating at the scroll limit.
- **FTS5 query sanitization** (P2): SQLite keyword search now strips FTS5 reserved words (`AND`, `OR`, `NOT`, `NEAR`) and all special characters (`{}:^+-`) to prevent query errors.
- **Search access_count race** (P2): Access count increment now batch-fetches current values before writing, reducing lost increments from concurrent searches.

### Improvements
- **README**: Comparison table updated with current market leaders (Mem0, Letta, Zep/Graphiti, Hindsight)
- **Search**: Added `knowledge_category` filter to `brain_search`
- **Qdrant**: `searchPoints` now supports range filters for temporal queries

## 2.3.1 (2026-03-29)

### Bug Fixes
- **brain_consolidate**: Fixed hardcoded `?sync=true` — async mode now works as documented. Added `sync` boolean parameter for explicit control.
- **MCP input validation**: `brain_store`, `brain_search`, `brain_delete`, and `brain_client` now validate required arguments before calling the API, returning clear error messages instead of passing `undefined`.
- **brain_export**: Added `limit` parameter (default 500) to prevent oversized responses. Description warns about large result sets.
- **Server version**: Self-reported version now matches package.json.

### Reliability
- All API routes sanitize error messages (no internal details leaked to clients)
- Fetch timeouts on all HTTP calls (embedders, LLM providers, Baserow, webhooks)
- Export endpoint paginated, import endpoint now indexes keywords + extracts entities
- Webhook dedup tenant-scoped, Postgres graceful shutdown, auth map cleanup

## 2.3.0 (2026-03-26)

### Multi-Path Retrieval with RRF Fusion

Search now runs three retrieval paths in parallel and merges results using Reciprocal Rank Fusion -- dramatically improving recall for exact names, technical terms, and entity-connected memories.

#### New Retrieval Paths
- **BM25 keyword search** -- Full-text search via Postgres tsvector/GIN index or SQLite FTS5 fallback. Catches exact term matches that embedding similarity misses (client names, technical terms, error codes).
- **Entity graph BFS retrieval** -- Breadth-first spreading activation through the entity relationship graph. Starts from entities mentioned in the query, traverses co-occurrence and typed relationships (uses, works_on, contact_of) with configurable activation decay. Surfaces memories connected by entity relationships, not just text similarity.
- **Reciprocal Rank Fusion (RRF)** -- Merges ranked lists from all three paths using `score(d) = sum(1/(k+rank))`. Items found by multiple paths get boosted. Pure JS, zero dependencies.

#### New Files
- `api/src/services/rrf.js` -- RRF fusion algorithm with 13 unit tests
- `api/src/services/keyword-search.js` -- BM25/FTS keyword search service
- `api/src/services/graph-search.js` -- BFS spreading activation graph retrieval
- `api/scripts/backfill-keyword-index.js` -- One-time migration for existing memories
- `api/tests/rrf.test.js` -- Comprehensive test suite (edge cases, score verification, 3-path scenarios)

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
- `MULTI_PATH_SEARCH=true|false` -- Feature flag (default: true)
- `RRF_K=60` -- RRF smoothing constant (range 50-100)
- `GRAPH_SEARCH_MAX_DEPTH=2` -- Max BFS hops through entity graph
- `GRAPH_SEARCH_DECAY=0.8` -- Activation decay per hop
- `GRAPH_SEARCH_CAUSAL_BOOST=2.0` -- Boost for typed relationships vs co_occurrence

#### Testing
- 13 new RRF unit tests, 114 total tests passing

Inspired by [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)'s 4-way parallel search architecture.

## 2.2.0 (2026-03-24)

### Noise-Free Entity Extraction
- **Pattern-based filtering** with 50+ generic noun/adjective blocklists. Filters out CSS properties, HTML attributes, camelCase/snake_case code identifiers, shell commands, error codes, sentence fragments, French prose, and generic adjective+noun phrases.
- **Retroactive cleanup script** (`scripts/cleanup-garbage-entities.js`) purges existing noise entities from the database.

### Per-Client Knowledge Base
- **Fingerprint-based client identification** with accent normalization and fuzzy name resolution ("AL" resolves to "acme-loans").
- **`brain_client` MCP tool** -- one call returns everything known about a client, grouped by knowledge_category (brand, strategy, meeting, content, technical, relationship, general).
- **Auto-resolve client_id** -- memories without explicit client_id are automatically tagged using fingerprint matching against the content.

### Gemini Embedding 2
- **Task-type-aware embeddings** at 3072 dimensions. Uses `RETRIEVAL_DOCUMENT` for storage, `RETRIEVAL_QUERY` for search.
- **Matryoshka support** for flexible dimensionality (3072/1536/768).

### Smarter Consolidation
- The 6-hour LLM pass now **reclassifies knowledge categories** and **infers entity relationship types** (contact_of, same_owner, uses, works_on, competitor_of).
- Supports OpenAI, Anthropic, Gemini, and Ollama as consolidation LLM providers.

## 2.1.0 (2026-03-22)

### Entity Relationship Graph
- **Co-occurrence tracking** via `entity_relationships` table. Relationships are automatically detected during consolidation.
- **Interactive D3.js visualization** -- dark theme, force-directed layout, search, zoom, and PNG export.
- **`brain_graph` MCP tool** and `GET /graph` API endpoint for entity relationship queries.

### Webhook Notifications
- **Real-time dispatch** on memory store, supersede, and delete events via configurable webhook URLs.
- Fire-and-forget to any HTTP endpoint. Configure via `WEBHOOK_URLS` and `WEBHOOK_EVENTS` env vars.

### Import/Export
- **`brain_export` and `brain_import` MCP tools** for full backup and migration support.
- Export all memories as JSON, import with automatic deduplication and batch embedding.
- Safe for embedding provider migration -- re-embeds all content with the current provider.

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
- **Access-weighted search** -- search results factor in access count alongside similarity and confidence, rewarding frequently-accessed memories
- **Insight removal** -- consolidation-generated insights can now be removed when source memories are deleted
- **Entity fix** -- fixed entity extraction for memories with no client_id

## 1.4.0

### Token Optimization
- **Compact response format** -- `brain_briefing` and `brain_search` now default to `compact` mode: content truncated to 200 chars, low-importance events filtered, essential fields only. **~70-80% token reduction** on typical briefings.
- **Summary format** -- `format=summary` returns counts + one-line headlines only for minimal token usage (~90% reduction).
- **Full format preserved** -- `format=full` restores original verbose behavior when complete content is needed.
- **Importance-ranked sorting** -- briefing results sort by importance (critical/high first) then recency, so agents see what matters first.

### Security
- **Prompt injection hardening** -- consolidation engine now applies full XML entity escaping (`&`, `<`, `>`, `"`, `'`) on all user content and payload attributes. JSON code-fence stripping handles LLMs that wrap output in markdown. Top-level structure validation rejects non-object responses.

### Performance
- **O(1) supersedes lookup** -- fact/status supersede checks now query Qdrant by `key`/`subject` field directly instead of scanning all active records. New payload indexes for `key` and `subject`.
- **Async consolidation** -- `POST /consolidate` returns a job ID immediately (HTTP 202). Poll status via `GET /consolidate/job/:id`. Jobs auto-expire after 1 hour. Backward-compatible: `?sync=true` preserves blocking behavior.
- **Briefing pagination** -- `limit` parameter (1-500, default 100) prevents unbounded responses.

### New Features
- **Memory deletion** -- `DELETE /memory/:id` soft-deletes a memory (marks inactive). Agent-scoped keys can only delete their own memories. Audit fields: `deleted_at`, `deleted_by`, `deletion_reason`. Exposed via `brain_delete` MCP tool.
- **Request correlation IDs** -- every request gets an `X-Request-ID` header (generated or propagated) for cross-service tracing.
- **Configurable MCP timeouts** -- `BRAIN_MCP_TIMEOUT` (default 15s) and `BRAIN_MCP_CONSOLIDATION_TIMEOUT` (default 120s) environment variables.

### Reliability
- **Graceful shutdown** -- API server handles SIGTERM/SIGINT, drains in-flight connections, force-exits after 10s timeout.
- **Alias cache cold-start fix** -- 67 built-in KNOWN_TECH aliases pre-seeded on startup so technology entities resolve immediately, even before first consolidation run.
- **Entity name normalization** -- consolidation normalizes canonical names (trim, collapse whitespace) and uses case-insensitive lookup to prevent duplicate entities like "Acme Corp" vs "acme corp".
- **SQLite error logging** -- silent catch blocks now only suppress genuine UNIQUE constraint duplicates; real errors (disk full, permission denied) are logged at WARN level.

### Testing
- **41 new tests** -- validation middleware (23 tests: type, content, source_agent, importance, metadata, string fields, composite) and entity extraction (18 tests: basic, technologies, domains, quoted names, capitalized phrases, alias cache, dedup, cold-start).
- **81 total tests**, all passing.

### Indexes
- New Qdrant payload indexes: `key` (Keyword), `subject` (Keyword) -- created on startup for existing collections.

## 1.2.0

### Entity Extraction & Linking
- **Automatic entity extraction** -- memories extract entities (clients, technologies, workflows, people, domains, agents) at storage time using fast regex + known-tech dictionary. No LLM call, non-blocking (fire-and-forget).
- **Entity graph** -- new `entities`, `entity_aliases`, and `entity_memory_links` tables in SQLite/Postgres. Alias resolution enables canonical entity deduplication.
- **LLM entity refinement** -- consolidation engine discovers entities regex missed, normalizes aliases, classifies types. Alias cache refreshes after each run for compounding accuracy.
- **Qdrant native entity filtering** -- `entities[].name` payload index enables entity-scoped vector search with no result-count ceiling. `GET /memory/search?entity=Docker` filters at the Qdrant level.
- **Shared `linkExtractedEntities`** -- single function for entity find-or-create-then-link, used by memory store, webhook, and backfill.
- **New `brain_entities` MCP tool** -- list, get, memories, stats actions for the entity graph.
- **New API endpoints** -- `GET /entities`, `GET /entities/stats`, `GET /entities/:name`, `GET /entities/:name/memories`.
- **Briefing entity summary** -- `GET /briefing` includes `entities_mentioned` in summary.
- **Stats entity counts** -- `GET /stats` includes entity breakdown by type and top-mentioned.
- **Backfill script** -- `api/scripts/backfill-entities.js` extracts entities from all existing memories.

### Bug Fixes
- **Fixed `scrollPoints` filter bug** -- boolean `false` values (e.g. `{consolidated: false}`) were silently dropped, causing consolidation to reprocess all memories instead of only unconsolidated ones.
- **Fixed Postgres `createEntity` race condition** -- concurrent inserts for the same entity now use `ON CONFLICT` upsert instead of SELECT-then-INSERT.
- **Fixed `brain_entities` validation** -- `get` and `memories` actions now return an error when `name` is missing instead of silently falling through to `list`.
- **Removed user input echo from error responses** -- 404/400 errors no longer reflect request parameters.

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
