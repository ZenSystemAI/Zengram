# Changelog

This changelog covers the entire Zengram project (API, MCP server, adapters, and tooling).

This root file is the canonical changelog for the project. The `mcp-server/CHANGELOG.md` tracks only the published `@zensystemai/zengram-mcp` package history.

## 4.5.0 (2026-07-03)

Retrieval-stack release. Adds the three biggest precision/recall levers from our production deployment — a cross-encoder reranker stage, weighted RRF, and an entity-graph retrieval path — plus first-class self-hosted model support (local embedding endpoints, instruction prefixes, reasoning-model compatibility). Everything is gated and defaults to current behavior: with no new env vars set, search results are byte-identical to 4.4.0.

### Cross-encoder reranker (`RERANK_ENABLED`, off by default)
- New `services/reranker/` provider + generic HTTP client speaking the two standard `/rerank` shapes (TEI, and Cohere-compatible: Infinity / vLLM / Jina / Cohere / llama.cpp `--reranking`). Probes the endpoint at startup and degrades gracefully to fused order on any outage — a reranker failure can never make search worse than baseline.
- Re-scores a deeper fused candidate pool (`RERANK_CANDIDATES`, default 40) after RRF in `/memory/search`, `/reflect`, and `/research`; the rerank score replaces the sim/RRF blend inside `effective_score` while confidence decay, capped access boost, temporal proximity, and importance still apply. The response `score` field stays honest vector similarity.
- Client-side batch chunking (`RERANK_MAX_BATCH`, default 32) so servers that cap request batch size don't silently drop candidates.
- Why first: on our private bilingual production corpus (765 active memories, 70 judge-paraphrased queries, one variable at a time), adding `bge-reranker-v2-m3` roughly doubled MRR (0.375 → 0.771) and lifted recall@5 to 1.0 over the dense+full-text baseline. Your corpus will differ — measure with the eval harness — but this is the single highest-leverage retrieval upgrade we know of.

### Entity-graph retrieval (`GRAPH_RETRIEVAL_ENABLED`, off by default)
- The write path has always maintained an entity graph (`entities`, `entity_memory_links`, co-occurrence `entity_relationships`); until now nothing read it at search time. New `services/graph-retrieval.js` extracts entities from the query (same dictionary/alias extractor as the write path — no LLM call), expands one hop over the co-occurrence graph weighted by normalized edge strength (`GRAPH_HOP_DECAY`, cap via `GRAPH_NEIGHBOR_LIMIT`), and feeds linked memories into RRF fusion as a weighted third list (`RRF_GRAPH_WEIGHT`, default 0.5).
- Tenant-scoped and additive: graph candidates are client-filtered in SQL and the graph path returns empty on any error rather than breaking search.

### Retrieval & ranking
- **Weighted RRF**: `RRF_VECTOR_WEIGHT` / `RRF_KEYWORD_WEIGHT` bias fusion toward semantic or exact matches (default 1/1 = vanilla RRF, unchanged).
- **Vector-outage resilience**: an embedding-backend failure now degrades `/memory/search` to the surviving paths (keyword/graph) with `retrieval.degraded: true` metadata instead of failing the request — and returns an honest 503 when nothing can answer, instead of an empty 200 that reads as "no memories exist".
- **Opt-in multilingual full-text** (`BM25_TSCONFIG=zengram_multi`): a managed accent-folding text-search config (`unaccent` + `simple`) for mixed-language corpora, with self-healing one-time reindex when the config changes (tracked in a `zengram_meta` row). The default stays `english` — accent folding trades away English stemming, so English-only deployments should not switch.

### Self-hosted models
- **Local embedding endpoints**: `OPENAI_BASE_URL` points the `openai` embedding provider at vLLM / Infinity / TEI / llama.cpp; the `dimensions` request param is now sent only when explicitly configured (local servers reject unexpected params), with the native dimensionality probed at startup.
- **Instruction prefixes**: `EMBED_QUERY_PREFIX` / `EMBED_DOC_PREFIX` for instruction-aware encoders (qwen3-embedding, e5, gte) — applied asymmetrically (query side on search, doc side on store), with `\n`/`\t` escapes decoded so multi-line instructions survive env files. Instruction-tuned encoders can score *below* older models without their prefix — set it.
- **Re-embed tooling**: `api/scripts/reembed.js` re-embeds a corpus in place for an encoder swap, including a dimensionality change (drops HNSW → re-types the column → re-embeds → rebuilds). Dry-run by default.
- **Reasoning-model compatibility**: `<think>` blocks leaked by self-hosted reasoning models are stripped before JSON extraction in consolidation and reflect (an unclosed `<think>` is also handled), and `LLM_CHAT_TEMPLATE_KWARGS` (e.g. `{"enable_thinking": false}`) is forwarded to OpenAI-compatible servers to disable thinking at the source. `OPENAI_BASE_URL` is honored by the LLM provider as well.

### MCP server
- **Response truncation**: tool responses above `BRAIN_MCP_MAX_RESPONSE_CHARS` (default 24000) return a valid-JSON truncation envelope suggesting `format=index`/`compact` retries, instead of blowing the client's context window. `BRAIN_MCP_PRETTY_JSON` toggles pretty-printing (default compact).
- **Identity lock** (`BRAIN_MCP_LOCK_SOURCE_AGENT`, off by default): when enabled, the env-configured `source_agent` always wins over tool-call arguments — an impersonation guard for multi-writer setups. The default keeps the existing public contract (args may override).

### Hardening
- Startup config validation: placeholder API keys (including the `.env.example` default), sub-16-char keys, and whitespace-padded keys now fail fast with actionable errors instead of running "protected" by a guessable credential.
- Route input hardening on `/entities`, `/briefing`, and `/export`: tool-call control-markup rejection and bounded integer params, reusing the existing `request-utils` validators.
- `knowledge_category` filtering restored in structured-store queries (`/memory/query`).
- New `api/scripts/dedupe-entities.js`: transactional duplicate-entity merge (links, relationships, aliases retargeted to the highest-mention winner), dry-run by default.

### Tests
- 343 tests (was 287): reranker HTTP client + chunking, weighted RRF, graph retrieval, rerank-score ranking composition, embed prefixes, BM25 config, `<think>` stripping, MCP truncation, config validation, and route-hardening suites.

## 4.4.0 (2026-07-03)

Correctness + retrieval-quality release. Restores true multi-agent identity (the headline feature actually works again), overhauls the search ranking so hybrid fusion is used instead of discarded, fixes a cross-tenant supersede bug, and hardens the LLM/consolidation pipeline, temporal resolution, Docker deployment, and MCP surface. One breaking default for Gemini deployments — see Breaking.

### Breaking
- **Gemini embedding default dimensionality is now 1536** (Matryoshka truncation, matching what `.env.example` always documented) and truncated vectors are L2-renormalized. The old code default of 3072 also crashed at startup — pgvector's HNSW caps the `vector` type at 2000 dims. Existing Gemini deployments with a 3072-dim column must set `GEMINI_EMBEDDING_DIMS=3072` (now served by a halfvec-cast HNSW index) or re-embed. A new startup dims-guard fails fast with an actionable message when the column and provider disagree.
- **Rolling multi-instance deploys**: the supersede advisory-lock key now includes `client_id`, so a v4.3 instance and a v4.4 instance do not serialize same-key writes against each other during the overlap window (two active rows for one key are possible under concurrent writes). Single-instance deployments — the normal docker-compose setup — are unaffected; multi-instance operators should briefly quiesce keyed fact/status writes during the rollout.

### Multi-agent identity (restored)
- **Writes honor the caller's validated `source_agent` again.** v4 coerced every write to a single canonical agent — which silently broke the product's core promise: briefings could not distinguish agents and corroboration could never fire. Each agent now writes under its own identity.
- **Cross-agent corroboration is back**: a second agent storing identical content is recorded on the existing memory (`observed_by` append, capped at 20, `corroborated: true` in the response) instead of dropped as a duplicate.
- The `brain_store` MCP tool's `source_agent` is optional and defaults from `BRAIN_MCP_SOURCE_AGENT` (set it per agent in multi-agent fleets); the schema/handler contract mismatch is fixed.

### Retrieval & ranking
- **Fusion is no longer discarded**: final ordering blends normalized RRF with vector similarity (`RANK_W_SIM`/`RANK_W_RRF`, new `services/ranking.js`, unit-tested) — a memory found by both paths genuinely outranks an equal-similarity single-path hit.
- **Keyword-only results no longer get a fabricated 0.5 similarity** (and a genuine similarity of 0 is honored — the old `(score || 0.5)` treated it as missing).
- **HNSW recall fix for scoped queries**: searches run with `SET LOCAL hnsw.ef_search` scaled to the fetch depth and, on pgvector ≥ 0.8, `hnsw.iterative_scan = relaxed_order` — sparse `client_id`-scoped tenants no longer get zero results from post-filter candidate exhaustion (capability probed once at init).
- **Filter parity across paths**: keyword-sourced candidates are re-checked against `category`, `knowledge_category`, date-range, `at_time`, and active-state filters that previously only the vector path applied — and the `at_time` validity filter now runs before the result-limit trim, so filtered rows can't leave a response short.
- The vector score floor is env-configurable (`SEARCH_SCORE_FLOOR`, default 0.55 ≈ cosine 0.1); the old hardcoded 0.3 equaled cosine −0.4 and filtered nothing.
- The access-frequency boost is capped (`RANK_ACCESS_BOOST_CAP`, default 2.0), ending the popularity runaway where often-returned memories crowded out better matches.
- Session-diversity reranking treats untagged results as singleton sessions competing at rank 0 instead of burying them below every tagged result; internal ranking fields no longer leak into API responses.
- Multipath candidate depth raised (fetch cap 50 → 200), so `limit > 25` queries aren't silently truncated.
- Keyword search uses `websearch_to_tsquery` (quoted phrases, negation, never throws on odd syntax); docs and comments stop calling `ts_rank_cd` "BM25".

### Fixed
- **Tenant isolation**: fact/status supersede lookups and the atomic supersede transaction are scoped by `client_id` (with `client_id` folded into the advisory-lock key) — one tenant's write can no longer deactivate another tenant's same-keyed fact. Mirror-table uniqueness is per-tenant too: `UNIQUE(key, client_id)` / `UNIQUE(subject, client_id)`, migrated idempotently.
- **Temporal resolution is timezone-aware** (`BRAIN_TIMEZONE`, defaults to the server zone): "today"/"yesterday"/"this week" resolve to the correct civil day on non-UTC deployments, and "N months ago" no longer overflows day-of-month into inverted (empty) windows.
- **LLM truncation is detected** on all four providers (typed `LlmTruncationError`) instead of surfacing as a JSON-parse failure that permanently retried the same oversized batch; default consolidation output budget raised to 8192 (`LLM_MAX_TOKENS`).
- Contradiction resolution honors the LLM's `suggested_resolution` when deciding which memory to supersede, falling back to newer-wins; connection metadata accumulates across runs (deduped, capped 20) instead of being overwritten.
- Gemini no-candidate and Anthropic empty-content responses throw descriptive errors instead of crashing; consolidation and reflect pass an explicit low temperature.
- `batchUpdateEntityType` is a single collection-scoped UPDATE (was an N+1 read-modify-write loop that could clobber concurrent payload merges).
- `KNOWN_SYSTEMS` entity matching uses word boundaries (no more substring false positives); entity merge/reclassify run in transactions.
- `GET /briefing` and `GET /export` validate `since` as ISO 8601 (400 on garbage input).
- The eval harness seeds through the (gated) import endpoint again — `operator_approved` was missing, so it 403'd on step one.

### Added
- Shared LLM retry helper: one exponential-backoff retry on 429/5xx/network errors, never on truncation or other 4xx (`LLM_RETRY_BASE_MS`).
- Consolidation backlog cap per run (`CONSOLIDATION_MAX_MEMORIES`, default 500, oldest-first).
- Deep health probe: `GET /health` checks Postgres and the embedding provider, returning 503 `{status:'degraded'}` on dependency loss.
- MCP tool annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`title`) on all 13 tools; graceful stdio shutdown and a startup connectivity retry.
- Eval harness reports hit@k, fraction recall@k, and MRR@k side by side; the bundled fixture grew to 34 memories / 12 queries with distractor clusters.
- Postgres pool hygiene: explicit `max` (`PGPOOL_MAX`), idle/connection timeouts, and `statement_timeout` (`PG_STATEMENT_TIMEOUT_MS`) on both pools; the dedup index is now composite `(content_hash, client_id, type)`.

### Security
- Credential scrubbing covers Stripe, Google API, Slack, and standalone GitHub token formats.
- `DELETE /collections/:name` (hard delete) requires `operator_approved=true`, matching the import gate.
- `TRUST_PROXY` env drives Express `trust proxy` so the failed-auth IP throttle keys on real client IPs behind reverse proxies.
- Docker hardening: `no-new-privileges` + `cap_drop: ALL` on both services (Postgres re-adds only its required caps), digest-pinned base image, `.dockerignore`, and a production override with read-only rootfs, tmpfs `/tmp`, and log rotation.
- CI: `npm audit --audit-level=high` is now a blocking gate; tests run under a non-UTC timezone to catch civil-day regressions.

### Docs
- Removed stale single-operator framing from the auth docs (and internal deployment agent names from the public config doc); documented the ranking blend, new env vars, and the MCP `index` format + timeout/identity env vars.
- `docs/benchmarks.md` no longer points at a non-existent reproduction directory: it now says plainly that the LongMemEval runner isn't in-repo yet and routes readers to the runnable eval harness.

## 4.3.0 (2026-06-13)

Feature + hardening release. Adds agentic multi-hop retrieval (`brain_research`), grounds reflection answers with verifiable citations, and ports a set of generic safety/quality improvements from the production deployment. One behavior change to the destructive `/export/import` endpoint (now gated) — see Changed.

### Added
- **`brain_research` / `POST /research` — agentic, iterate-until-sufficient retrieval.** A bounded loop (the "Sufficient Context" agent pattern): multi-path retrieve → one LLM call that drafts an answer *and* judges SUFFICIENT/INSUFFICIENT while naming the exact missing facts → the named gap becomes the next query (the gap is the decomposition, no separate planner) → grounded synthesis with per-claim `[mem:<id>]` citations (fabricated ones stripped). Opt-in behind `RESEARCH_ENABLED=true`; never touches the `GET /memory/search` hot path; rate-limited with consolidation. New `brain_research` MCP tool (13 tools total).
- **Reflection citation grounding.** `POST /reflect` now asks the LLM to cite source memories as `[mem:<id>]`, strips any citation referencing a memory that wasn't actually retrieved, and returns `cited_memory_ids` for auditability.
- **Full temporal/lifecycle export-import round-trip.** `GET /export` and `POST /export/import` now carry `supersedes`, `superseded_at`, `deleted_at`, `deletion_reason`, `valid_from`, `valid_to`, `observed_by`, `observation_count`, `consolidated`, and (scrubbed) `metadata`, so a backup→restore preserves supersede chains and temporal validity.
- **Read-only search.** `GET /memory/search` accepts `read_only=true` / `track_access=false` so background sweeps (reflection, eval, consolidation candidate-gathering) don't bump access counts and pollute the recency/frequency signals feeding relevance scoring.
- Unit tests for the new helpers — request-param parsing, reflection/research/consolidation JSON extraction + grounding, embedding-dimension parsing, the markup guard, and the import gate. 176 tests total (up from 128).

### Changed
- **`POST /export/import` now requires `operator_approved=true`** (in the body or query) and returns `403` otherwise. Import overwrites live memories, so a destructive restore now needs explicit operator authorization. The `brain_import` MCP tool gained a required `operator_approved` argument.
- **Consolidation auto-resolves contradictions** between current-state assertions: when the LLM flags a contradiction between two `fact`/`status` memories, the older one is superseded (`superseded_reason: contradiction-resolved-auto`). Events and decisions stay active as historical records — the audit-trail event is still written.
- **Consolidation reports honest status.** Runs/jobs with failed batches now report `partial` instead of `complete`, and LLM JSON parsing tolerates code fences + trailing prose with array-field schema validation.
- **Consolidation rate limit is configurable** via `RATE_LIMIT_CONSOLIDATION` (default raised from 1/hour to 10/hour) so a manual run plus a cron tick no longer 429s the operator.

### Security
- **Tool-call control-markup guard.** Stored content/metadata/agent/string fields are rejected when they smuggle fake tool-call control markup (`<tool_call>`, `<function>`, `<arguments>`, …) — a prompt-injection vector against any later agent that reads the memory back. Trusted restore paths can opt out.

### Fixed
- Embedding dimensions fail loudly on a misconfigured `*_EMBEDDING_DIMS` env var (non-integer or ≤ 0) instead of silently producing wrong-sized vectors that mismatch the pgvector column.

### Notes
- These improvements were ported from the maintainer's production Zengram deployment; only generic, product-worthy code was brought over (no operator/client-specific data). The cross-run sliding-window contradiction detection from that deployment was evaluated and deferred to a later release.

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
