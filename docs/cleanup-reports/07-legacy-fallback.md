# 07 — Legacy / Fallback / Deprecated

Branch: `cleanup/8-pass-refactor` @ `556642c`
Scope audited: `api/src`, `mcp-server/src`, `adapters/`, `api/scripts/`, `scripts/`, `examples/`, `sdk/`, `.env.example`, `docker-compose*.yml`, `README.md`, `CHANGELOG.md`, top-level `CLAUDE.md`, `api/package.json`, `mcp-server/package.json`.

## Summary

v4 removed the big stuff (graph routes, dashboard, webhook/subscribe, client resolver, SDK packages, n8n+openclaw adapters, per-agent auth). What remains is a thick second layer of legacy that the 8‑pass missed, mostly in three categories:

1. **Qdrant nomenclature that outlived the Qdrant binary.** v4 renamed `qdrant.js` → `pgvector.js` but kept API-compatible function names as "shims" (`initQdrant`, `createQdrantCollection`, `deleteQdrantCollection`, `listQdrantCollections`) and left "Qdrant" baked into comments, log lines, route response fields (`stored_in.qdrant: true`), and a public stats field (`exists_in_qdrant`). Current CLAUDE.md + CHANGELOG explicitly say Qdrant is gone.
2. **MCP tools that call non-existent API routes.** `brain_reclassify` action=`suggest` calls `GET /entities/reclassify/suggestions` (route does not exist — the CHANGELOG lists that endpoint as deleted in v4). `brain_batch` calls `POST /memory/batch` (route does not exist). Both tools are silently broken. Both are absent from the official tool list in `CLAUDE.md` (which lists 12 tools; MCP server exposes 14).
3. **Dead fallback backends.** `STRUCTURED_STORE=sqlite` and `STRUCTURED_STORE=baserow` are still wired (interface dispatch, full SQLite store ~467 LOC, Baserow store ~126 LOC). `.env.example` says "v4: Postgres is required." No code path exercises the fallbacks in Docker, tests, or scripts. Baserow was removed from docs in v4 but not from the code.

Plus: broken migration scripts still imported from the deleted `qdrant.js`; unreachable cross-agent corroboration code in `memory.js` (source_agent coerced to one value, so "different agent → corroborate" branch cannot fire); a `/collections` route that no other route references; an empty `sdk/` directory; README, MCP server package description, and MCP self-reported version all still advertise v2.x features.

Rough size of remaining cleanup: ~800–1,200 LOC of service code + ~600 LOC of unused SQLite store + ~130 LOC of Baserow + stale comments/strings across ~15 files. Not a v4 re-opening — a v4.1 follow-up that closes the sweep.

## Critical assessment

The v4 sweep cut the rooms but left the floorplan labels. A reader who lands on `api/src/services/pgvector.js:100` with `export async function initQdrant() { return initPgvector(); }` will reasonably conclude Qdrant is still a thing. Same for the API response on `POST /memory` which hands back `stored_in: { qdrant: true, structured_db: true }`. That's false information to every client of this API.

The SQLite-vs-Postgres situation is the single biggest unresolved architectural decision. v4 made Postgres required in `.env.example` and in `docker-compose.yml` (`STRUCTURED_STORE=postgres` is hard-wired in the API service env); but the code's default at `stores/interface.js:4` is still `'sqlite'`, and the full SQLite store is kept with its own FTS5 code path, its own entity tables, its own init flow. Either SQLite is a supported dev-local backend (in which case `.env.example` should document it and tests should cover it), or it's dead and should be deleted. It cannot sit in this Schrödinger state.

The broken MCP tools are the worst lived-product bug. `brain_reclassify suggest` fails silently with a 404 wrapped in a generic MCP error — a user trying to clean up entities will see nothing useful. Either reclassify-suggestions gets re-implemented (the service helper is there; only the route is missing) or the tool is removed. `brain_batch` has no server endpoint at all and should just be deleted.

## Findings (ordered by confidence + cleanup value)

### HIGH — MCP tool `brain_reclassify` (action=suggest) calls a non-existent route
**File:** `mcp-server/src/index.js:595`
- What's there: `result = await apiRequest('/entities/reclassify/suggestions');`
- Why it's legacy: CHANGELOG v4 line 14 lists "the entity-reclassify-suggestions endpoint removed." The API has only `POST /entities/reclassify` (apply) — no suggestions endpoint. `action=suggest` returns a 404 wrapped in MCP error.
- Proposed: Delete the whole `brain_reclassify` tool (tool def at `mcp-server/src/index.js:347`, handler at `:592`). It's also not listed in `CLAUDE.md` (which enumerates the canonical 12 tools). If reclassify is still wanted, keep the route and expose it via `brain_entities` actions.
- Risk: Nothing in-repo or in `CLAUDE.md` uses it. Low.

### HIGH — MCP tool `brain_batch` calls a non-existent route
**File:** `mcp-server/src/index.js:403` (tool def) and `:629` (handler calling `/memory/batch`)
- What's there: tool that POSTs to `/memory/batch` with array of memories
- Why it's legacy: `api/src/routes/memory.js` has no `/batch` route (routes are `/`, `/search`, `/query`, `/:id` PATCH, `/:id` DELETE). Tool has never worked in v4.
- Proposed: Delete tool def + handler. Not in `CLAUDE.md`'s canonical tool list.
- Risk: None. Dead from the client's perspective.

### HIGH — `api/scripts/backfill-entities.js` and `backfill-keyword-index.js` import a deleted module
**Files:**
- `api/scripts/backfill-entities.js:12` — `import { initQdrant, scrollPoints, updatePointPayload } from '../src/services/qdrant.js';`
- `api/scripts/backfill-keyword-index.js:12` — same
- Why it's legacy: `api/src/services/qdrant.js` was renamed to `pgvector.js` in v4. These scripts error on first line.
- Proposed: Delete both scripts. They're one-shot backfills for keyword index and entities — keyword index backfill was the v2.3.0 migration, entity backfill was the v1.2.0 migration. Both already ran at their time. If needed again, rewrite against `pgvector.js` — but almost certainly they're historical artifacts.
- Risk: None. They can't be executed as-is.

### HIGH — `api/scripts/rebuild-from-postgres.js` and `reindex-embeddings.js` are Qdrant-era scripts
**Files:**
- `api/scripts/rebuild-from-postgres.js:12-14` — `const QDRANT_URL = ...; const COLLECTION = 'shared_memories';` (full script talks to Qdrant HTTP API)
- `api/scripts/reindex-embeddings.js:5-13` — header describes Qdrant collection recreation flow
- Why it's legacy: no Qdrant container since v4 deploy (2026-04-12). These only make sense against Qdrant.
- Proposed: Delete. `api/package.json` has a `"reindex": "node scripts/reindex-embeddings.js"` npm script that currently points at a broken Qdrant script — also remove that script entry. If reindex-against-pgvector is needed, write a fresh one (pool.query to update vectors column).
- Risk: None — they'd fail on missing Qdrant.

### HIGH — `api/scripts/backfill-qdrant-to-pgvector.js` is a one-shot migration already done
**File:** `api/scripts/backfill-qdrant-to-pgvector.js`
- What's there: Zengram v4 migration from Qdrant to pgvector
- Why it's legacy: CHANGELOG v4.0.0 entry confirms the migration happened on 2026-04-12 (CLAUDE.md line 47: "Qdrant was retired during the v4 deploy on 2026-04-12").
- Proposed: Delete. One-shot migration, already run, target system doesn't exist anymore.
- Risk: None.

### HIGH — `api/scripts/cleanup-duplicates.js` and `cleanup-garbage-entities.js` are one-shots
**Files:**
- `api/scripts/cleanup-duplicates.js:15-16` — hard-codes Qdrant URL, talks directly to Qdrant HTTP
- `api/scripts/cleanup-garbage-entities.js` — described as "Applies the same filters as entities.js v2.2 retroactively"
- Why it's legacy: cleanup-duplicates cannot run (no Qdrant). cleanup-garbage-entities is the v2.2.0 one-shot that ran in March 2026 — the filters it retroactively applies have been in `entities.js` on-write for a year.
- Proposed: Delete both.
- Risk: None.

### HIGH — `scripts/v4-migrate-source-agent.sql` and `v4-migrate-qdrant-payloads.md` are completed migrations
**Files:**
- `scripts/v4-migrate-source-agent.sql`
- `scripts/v4-migrate-qdrant-payloads.md`
- Why it's legacy: one-shot migrations from the v4 deploy. Per CLAUDE.md they've been run; the canonical agent coercion now happens in `memory.js:26`.
- Proposed: Delete the `scripts/` directory entirely. Or move to `docs/history/` if you want the audit trail. These aren't forward-operational.
- Risk: None on deletion — they can't be rolled back anyway (v4 Postgres migration is baked in).

### HIGH — `mcp-server/src/index.js` self-reports version `2.5.1` in the actual Server constructor
**File:** `mcp-server/src/index.js:44` — `{ name: 'zengram', version: '2.5.1' }`
- What's there: hard-coded version string disconnected from both `package.json` (2.4.0) and the CHANGELOG (4.0.0)
- Why it's legacy: v1.0.2 CHANGELOG entry mentions "Version alignment between package.json and MCP server registration" — that discipline slipped again.
- Proposed: Read version from `package.json` (`import pkg from '../package.json' with { type: 'json' }`). Also bump `mcp-server/package.json` version to match the CHANGELOG's 4.0.0 and update the description (currently says "Qdrant + SQLite/Postgres").
- Risk: None.

### HIGH — `mcp-server/package.json` description and keywords advertise removed features
**File:** `mcp-server/package.json`
- What's there: description `"...multi-backend storage (Qdrant + SQLite/Postgres)"`; keywords include `"qdrant"`, `"knowledge-graph"`
- Why it's legacy: Qdrant retired; graph BFS retrieval removed in v4 (CHANGELOG line 13).
- Proposed: description → `"Persistent multi-path memory for AI agents — vector (pgvector) + BM25 keyword search with RRF fusion, credential scrubbing, auto-consolidation."`. Keywords → drop `"qdrant"`, `"knowledge-graph"`.
- Risk: Cosmetic only.

### HIGH — README.md is v2.x-flavored
**File:** `README.md`
- What's there:
  - Line 58: "Every memory lives in two places: Qdrant for semantic vector search and SQLite/Postgres..."
  - Line 66: "Entity graph — BFS traversal through relationship graph" (removed in v4)
  - Line 103: "Multi-path search (vector+BM25+graph)" (graph removed)
  - Line 143: "14 tools: ... `brain_client`, ..., `brain_graph`, ..." (both removed in v4)
  - Line 202: "Recently shipped: Web dashboard, Python SDK, SSE subscriptions, ..." (all removed in v4)
- Why it's legacy: None of these features exist in v4. `CLAUDE.md` canonical tool list is 12 tools, none of them `brain_client` or `brain_graph`.
- Proposed: Rewrite README to match CLAUDE.md. Either full rewrite, or at minimum strip dashboard/SDK/SSE/graph/brain_client/brain_graph references.
- Risk: Docs drift; no runtime impact.

### HIGH — `POST /memory` response includes `stored_in: { qdrant: true, ... }`
**File:** `api/src/routes/memory.js:68, 82, 101, 286`
- What's there: four places return `stored_in: { qdrant: true, structured_db: true }` to API clients
- Why it's legacy: No Qdrant. This is misinformation to callers.
- Proposed: Either remove the `stored_in` field (it's always `true` for both — zero information) or rename to `stored_in: { vector: true, structured_db: true }`.
- Risk: Breaking change if any external client parses that field. Grep of MCP server shows no consumer of `stored_in`. Likely safe.

### HIGH — `pgvector.js` exposes compat shim functions with Qdrant names
**File:** `api/src/services/pgvector.js`
- What's there:
  - Line 100 `initQdrant()` — shim that calls `initPgvector()`
  - Line 417 `createQdrantCollection(name)`
  - Line 423 `deleteQdrantCollection(name)`
  - Line 428 `listQdrantCollections()`
- Why it's legacy: File header line 3 literally says "Replaces qdrant.js in v4. API-compatible: routes and services that imported from qdrant.js can switch to this module with no behavior change." The shims exist so v3 callers don't break — but v4 deleted the v3 callers, so nothing needs the shim names.
- Proposed: Rename the four functions (`initPgvector` already exists and is called; drop `initQdrant`; rename the three `*QdrantCollection` to `*Collection`). Update the single caller site at `api/src/routes/collections.js:2, 16, 60, 101`.
- Risk: None — single caller internal to repo.

### HIGH — `/collections` route surface exposes `exists_in_qdrant` to API clients
**File:** `api/src/routes/collections.js:24, 30`
- What's there: response field `exists_in_qdrant: qdrantNames.has(c.name)` and `exists_in_qdrant: true` for discovered ones
- Why it's legacy: no Qdrant.
- Proposed: Rename to `exists_in_store` or drop the field — since the registry path is the only thing it distinguishes now, and `discovered` already signals "in vector store but not in registry."
- Risk: Low if we're sure no external client uses it.

### MEDIUM — `/collections` route has no agent-facing consumer
**File:** `api/src/routes/collections.js` (entire file, 115 LOC) and `api/src/services/collection-registry.js` (116 LOC)
- What's there: CRUD on named memory collections; `collection` column stored on every row in the vector table.
- Why it's legacy: `api/src/routes/memory.js` never passes `collection` to `upsertPoint` or `searchPoints` — the column exists but only the default `'shared_memories'` value is ever written. MCP server never mentions collections. The CLAUDE.md tool list has no `brain_collection` tool.
- Proposed: Either (a) finish wiring — add `collection` parameter to `brain_store`/`brain_search` MCP tools and memory routes, OR (b) delete the `/collections` route, `collection-registry.js`, `exists_in_qdrant` merge logic, and the `collection` column. Currently it's scaffolding around a feature that's only half built.
- Risk: Breaking if anything reads `/collections`. Grep shows nothing in-tree.

### MEDIUM — `SQLite` backend is kept but not used in any deploy path
**Files:**
- `api/src/services/stores/sqlite.js` (467 LOC)
- `api/src/services/stores/interface.js:4` — default `'sqlite'` when `STRUCTURED_STORE` unset
- Why it's legacy: `.env.example:36-38` says "v4: Postgres is required." `docker-compose.yml` hard-codes `STRUCTURED_STORE=postgres`. No test imports SQLiteStore. `better-sqlite3` is still a dependency in `api/package.json`.
- Proposed: **Pick one.** See dedicated section below.
- Risk: Depends on the decision.

### MEDIUM — `Baserow` store is fully dead
**File:** `api/src/services/stores/baserow.js` (126 LOC)
- What's there: full BaserowStore class with entity methods stubbed as no-ops; comments reference "Qdrant payload only"; "Graph/relationship methods — no-ops for Baserow"
- Why it's legacy: CHANGELOG v4 line 22 explicitly says "Removed per-agent key table, Baserow store section" from docs. `.env.example` no longer has BASEROW_* vars. No test uses it. No deploy references it (the `docker-compose.production.yml` `networks.baserow` is a leftover unrelated to THIS store — it was for the now-deleted client-resolver).
- Proposed: Delete `api/src/services/stores/baserow.js` + the `'baserow'` case in `stores/interface.js:22-26`.
- Risk: None. Baserow-backend was never operationally deployed against Postgres-era code.

### MEDIUM — `docker-compose.production.yml` baserow network is for a deleted service
**File:** `docker-compose.production.yml:3-6, 15, 22-24`
- What's there: `# - Baserow network access for client resolver` and a `baserow` external network attached to `memory-api`
- Why it's legacy: client-resolver service was deleted in v4 (CHANGELOG line 18). No code in the container dials Baserow.
- Proposed: Delete the baserow network attachment and the `baserow` network definition. Keep the `shared-brain-api` alias if external consumers use that hostname (the comment "backward compat: MCP Hub uses this hostname" suggests yes).
- Risk: None if nothing on the G6 LAN is actually hitting Baserow via this stack. Verify on G6 before ripping.

### MEDIUM — `STRUCTURED_STORE=none` branch references "Qdrant only"
**File:** `api/src/services/stores/interface.js:27-30`
- What's there: case `'none'` logs `'[store] Running without structured storage (Qdrant only)'`
- Why it's legacy: "Qdrant only" makes no sense now. Also, with no structured store, keyword search and entity linking are both disabled — half the v3 features v4 kept go dark. This branch is probably never used in production (Postgres is required), and its log string is misleading.
- Proposed: Delete the `'none'` case entirely. Require a real structured store. Or at least update the log string to "pgvector only."
- Risk: Low; nothing in deploys uses `STRUCTURED_STORE=none`.

### MEDIUM — `memory.js` cross-agent "corroboration" branch is unreachable
**File:** `api/src/routes/memory.js:42, 54-106`
- What's there: On dedup hit, checks `existingObservedBy.includes(source_agent)`. If yes, "same agent → true dedup." If no, "different agent → corroborate: record that another agent observed the same thing."
- Why it's legacy: Line 42 `source_agent = CANONICAL_AGENT;` coerces every write to `"claude-code"` BEFORE the dedup check. `existingObservedBy` for any existing memory is `["claude-code"]` (or the old per-agent name pre-migration). For new writes, the `includes` check is always true. The corroboration branch only fires on pre-v4 data with foreign source_agent.
- Proposed: Delete the entire corroboration branch. Keep the simple "exact duplicate → return existing" return. Remove `observed_by`, `observation_count`, `last_observed_at`, `MAX_OBSERVED_BY` — they're v3 multi-agent artifacts. Remove `observed_by` population at `:254` (lookup in memory.js).
- Risk: The `observed_by` array is surfaced in some read paths. Check search/briefing responses before ripping. Historical data should keep the payload for audit.

### MEDIUM — Consolidation prompt talks about "different AI agents working on different machines"
**File:** `api/src/services/consolidation.js:21`
- What's there: `You are analyzing a batch of agent memories from a shared brain system. These memories were stored by different AI agents working on different machines.`
- Why it's legacy: v4 canonical identity — one agent, one writer. The LLM is being primed with a falsehood.
- Proposed: Rewrite first line to `You are analyzing a batch of memories from Claude Code sessions. These memories were stored over time across many machines and tasks.`
- Risk: May change LLM output shape. Worth a single A/B on consolidation before shipping.

### MEDIUM — `index.js:64` "Qdrant needs dimensions" comment is stale
**File:** `api/src/index.js:64`
- What's there: `// Initialize embedding provider first (Qdrant needs dimensions)`
- Why it's legacy: pgvector, not Qdrant.
- Proposed: Update to `// Initialize embedding provider first (pgvector needs dimensions at init)`.
- Risk: None.

### LOW — `relevance-scorer.js` comments reference Qdrant payload + "Qdrant is slow"
**File:** `api/src/services/relevance-scorer.js:36, 111, 137`
- What's there: stale comments like "before Qdrant upsert", "skip near-duplicate check if Qdrant is slow", "Returns object to spread into the Qdrant payload"
- Proposed: s/Qdrant/pgvector/.
- Risk: None.

### LOW — `collection-registry.js` comments say "Qdrant collections"
**File:** `api/src/services/collection-registry.js:1, 15, 81`
- Proposed: s/Qdrant/vector store/ or drop the file entirely per the MEDIUM finding above.
- Risk: None.

### LOW — `entities.js` Qdrant reclassify logs
**File:** `api/src/routes/entities.js:117, 118, 120, 122, 130, 131, 146` — variable name `qdrantResult`, log strings, response field `qdrant_updated`/`qdrant_scanned`
- Proposed: Rename variable/fields to `vectorResult` / `vector_updated` / `vector_scanned`. Internal rename is safe; response field rename is a light API break.
- Risk: Response-field rename: low (no in-tree consumer).

### LOW — `briefing.js`, `export.js` Qdrant comments
**Files:** `api/src/routes/briefing.js:25`, `api/src/routes/export.js:23, 185, 236`
- Proposed: comment-only cleanup.
- Risk: None.

### LOW — `consolidation.js:14` comment "persisted via Qdrant events"
**File:** `api/src/services/consolidation.js:14`
- Proposed: Update to "persisted via memory events."

### LOW — `entities.js` KNOWN_TECH still lists 'qdrant' and 'openclaw' as known tech
**File:** `api/src/services/entities.js:9, 17`
- What's there: `'qdrant': 'Qdrant'`, `'openclaw': 'OpenClaw'`
- Why it's legacy: v4 dropped both. Harmless — these are just entity aliases for extraction. But inconsistent with "retired technology" messaging.
- Proposed: Keep. Historical memories will mention Qdrant and OpenClaw; we still want good NER on them. Just note it's intentional.
- Risk: None — note-only.

### LOW — `.env.example` still advertises `MULTI_PATH_SEARCH` and `RRF_K`
**File:** `.env.example:64-68`
- What's there: v3-era tuning flags
- Why it's potentially legacy: with graph BFS removed, `MULTI_PATH_SEARCH=true` only toggles BM25-alongside-vector. It's still a real gate, but the "multi-path" naming is v3 (used to mean vector + BM25 + graph). Consider renaming to `HYBRID_SEARCH=true` or dropping the flag — BM25+vector is so standard at this point that a kill-switch is not worth the complexity.
- Proposed: Drop `MULTI_PATH_SEARCH` (always on). Keep `RRF_K` but rename the env var comment to "hybrid" retrieval.
- Risk: Low. Default is already `true`.

### LOW — Empty `sdk/` directory
**File:** `sdk/` (directory exists, empty)
- Why it's legacy: CHANGELOG v4 removed Python + TypeScript SDK (line 17).
- Proposed: `rmdir sdk/`.
- Risk: None.

### LOW — `examples/multi-agent-scenario.sh` uses retired agent identities
**File:** `examples/multi-agent-scenario.sh:10-12`
- What's there: script simulating agents `claude-code`, `n8n`, `devops-agent` storing memories with different `source_agent` values
- Why it's legacy: v4 coerces all writes to `claude-code`. The scenario will run, but all three "agents" collapse into one — the whole demo point (agents discovering each other's work) is invalidated.
- Proposed: Either delete, or rewrite to model one agent writing under different `client_id` values. It's an example, not infrastructure, so deletion is fine.
- Risk: None.

### LOW — `adapters/bash/brain.sh` still reads `BRAIN_AGENT_NAME` env var
**File:** `adapters/bash/brain.sh:6`
- What's there: `SOURCE_AGENT="${BRAIN_AGENT_NAME:-my-agent}"` — then passes as `source_agent` on every request
- Why it's legacy: API coerces anyway. Harmless but misleading CLI surface; users might think setting BRAIN_AGENT_NAME does something.
- Proposed: Drop `--source_agent` parameter + `BRAIN_AGENT_NAME` env support. Or leave and document that it's ignored server-side.
- Risk: Trivial.

### LOW — `adapters/claude-code/sessionend/SKILL.md` example reflection mentions Qdrant
**File:** `adapters/claude-code/sessionend/SKILL.md:263, 268, 278`
- What's there: "Spent 40 minutes debugging Qdrant filter syntax..." in an example reflection
- Why it's legacy: example text from a v2.x-era session
- Proposed: Update example to mention pgvector filter syntax, or just update to something generic.
- Risk: Cosmetic only.

### LOW — `api/src/services/pgvector.js` comments reference Qdrant scoring behaviour
**File:** `api/src/services/pgvector.js:199-200, 239, 347`
- Why it's legacy: comments explain that pgvector scoring was designed to match Qdrant. True at migration time, unhelpful now.
- Proposed: Simplify comments to describe current behaviour without reference to the migration.
- Risk: None.

## SQLite-vs-Postgres question

**Recommendation: delete the SQLite backend.**

Evidence SQLite is dead:
- `.env.example` line 36: "v4: Postgres is required."
- `docker-compose.yml` sets `STRUCTURED_STORE=postgres` at the container level, overriding any `.env` value.
- `docker-compose.production.yml` (G6 prod) also forces Postgres.
- No test file imports `SQLiteStore` (tests in `api/tests/` — `entities.test.js`, `rrf.test.js`, `scrub.test.js`, `validate.test.js` — are all pure-function tests with no DB).
- No script in `api/scripts/` targets SQLite.
- MCP adapter, bash adapter, Claude Code adapter — none require SQLite.
- The only place SQLite-with-real-data is exercised is if a developer sets `STRUCTURED_STORE=sqlite` manually. Possible but undocumented.

Evidence SQLite is kept intentionally:
- The interface dispatcher defaults to `'sqlite'` (`stores/interface.js:4`).
- `better-sqlite3` is still in `api/package.json` dependencies.
- Isolated code paths in `entities.js`, `keyword-search.js`, and `relevance-scorer.js` have `store?.db` branches.
- Historical SKILL docs and tests may have assumed SQLite as the "zero-config local dev" path.

Proposed cut:
1. Delete `api/src/services/stores/sqlite.js`.
2. Remove `'sqlite'` case from `stores/interface.js:9-14`.
3. Change the default in `stores/interface.js:4` from `'sqlite'` to `'postgres'` (matching the deploy reality and the .env.example contract).
4. Remove `better-sqlite3` from `api/package.json`.
5. Remove `store?.db` branches in `entities.js`, `keyword-search.js`, `routes/entities.js:99-102` — leave the `store?.pool` (Postgres) branch.
6. Keep `'none'` branch deleted per separate finding, or re-purpose for a "vector-only, no structured metadata" test mode.

If you want to preserve a zero-config dev mode, the better move is an in-memory Postgres (pglite or testcontainers) for tests, and document Postgres as the only production-supported store. SQLite as a second backend means two query dialects, two FTS implementations, two entity schemas — ongoing tax for zero deploy benefit.

Alternative: keep SQLite as an officially supported dev backend. In that case:
- Add a line to `.env.example` documenting it.
- Add at least one test that imports `SQLiteStore` and round-trips a memory.
- Update `README.md` to mention it.
- Stop hard-coding `STRUCTURED_STORE=postgres` in `docker-compose.yml` — or at least explain the override.

**My call: delete.** The "fallback" is not being tested, not documented, and `.env.example` already tells users "Postgres is required."

## Adapter health

### `adapters/bash/` — LIVE but slightly stale
- 7-line README / SKILL.md is current. Commands (store, search, briefing, query, stats, consolidate) all map to real v4 endpoints.
- Stale: `BRAIN_AGENT_NAME` env var / `--source_agent` parameter are surface artifacts — server coerces to `claude-code`. Either drop them or document as no-op.
- No other issues.

### `adapters/claude-code/sessionend/` — LIVE and current
- SKILL.md matches the v4 MCP tool surface. Uses `brain_store` with `type: event`. Good.
- Only stale bits: example text in the "good reflection" mentions Qdrant (lines 263/268/278). Cosmetic.
- Keep.

### `adapters/claude-code/README.md` — current
- Matches the single `sessionend` skill that's in the tree. Fine.

### (gone)
- `adapters/openclaw/` — confirmed deleted in v4.
- `adapters/n8n/` — confirmed deleted in v4.

## Scripts and one-shots

### Top-level `scripts/`
- `v4-migrate-source-agent.sql` — one-shot Postgres migration (April 2026). **Delete** or move to `docs/history/`.
- `v4-migrate-qdrant-payloads.md` — advisory doc for the Qdrant-payload drift at v4 deploy. **Delete** or move to `docs/history/`.
- → Entire `scripts/` directory can go.

### `api/scripts/`
| Script | Status | Recommendation |
|---|---|---|
| `backfill-entities.js` | BROKEN — imports deleted `qdrant.js` | Delete |
| `backfill-keyword-index.js` | BROKEN — imports deleted `qdrant.js` | Delete |
| `backfill-qdrant-to-pgvector.js` | DONE — v4 deploy migration, already run | Delete |
| `cleanup-duplicates.js` | BROKEN — dials Qdrant HTTP | Delete |
| `cleanup-garbage-entities.js` | DONE — v2.2.0 retroactive cleanup, already run | Delete |
| `migrate-v4-dedupe.sql` | ? — not inspected; file name says v4 migration | Likely delete |
| `rebuild-from-postgres.js` | BROKEN — Qdrant-era rebuilder | Delete |
| `reindex-embeddings.js` | BROKEN — Qdrant-era reindex | Delete or rewrite for pgvector |
| `status-staleness.js` | LIVE — daily staleness cron | Keep; verify still works |
| `tier2-compression.js` | LIVE — weekly compression cron | Keep; verify still works |

The two LIVE scripts (status-staleness, tier2-compression) look like operational crons per their headers. Confirm they still run correctly against v4 routes before declaring them healthy — especially tier2-compression, which triggers consolidation (v4 consolidation has new corpus gating).

`api/package.json` has a `"reindex": "node scripts/reindex-embeddings.js"` npm script pointing at a broken script — remove that entry at the same time.

## Package.json audit

### `api/package.json`
- `"version": "1.0.0"` — mismatched with CHANGELOG's 4.0.0. Bump or remove (private package; doesn't actually publish).
- Dependencies:
  - `better-sqlite3` — remove if SQLite is dropped per recommendation above.
  - `express` — needed.
  - `node-cron` — needed.
  - `openai` — needed (embedding + consolidation clients use SDK).
  - `pg` — needed.
- `"scripts": { "reindex": "node scripts/reindex-embeddings.js" }` — broken target. Remove.

### `mcp-server/package.json`
- Version `2.4.0` — mismatched with CHANGELOG 4.0.0 and with the hard-coded `2.5.1` in `index.js:44`. Align all three.
- Description references Qdrant + multi-backend. Update.
- Keywords include `"qdrant"` and `"knowledge-graph"`. Drop both.
- Only dependency is `@modelcontextprotocol/sdk`. Clean.

## Kill list

Confidence: **HIGH** — safe to delete without replacement.

Files:
- `sdk/` (empty directory)
- `api/scripts/backfill-entities.js`
- `api/scripts/backfill-keyword-index.js`
- `api/scripts/backfill-qdrant-to-pgvector.js`
- `api/scripts/cleanup-duplicates.js`
- `api/scripts/cleanup-garbage-entities.js`
- `api/scripts/rebuild-from-postgres.js`
- `api/scripts/reindex-embeddings.js`
- `api/scripts/migrate-v4-dedupe.sql` (verify contents first — if it's the done v4 dedup migration, delete)
- `scripts/v4-migrate-source-agent.sql`
- `scripts/v4-migrate-qdrant-payloads.md`
- `api/src/services/stores/baserow.js`
- `examples/multi-agent-scenario.sh` (example demonstrating feature v4 retired)

Code sections:
- `api/src/services/pgvector.js:100-103` — `initQdrant` shim
- `api/src/services/pgvector.js:415-431` — rename `createQdrantCollection`, `deleteQdrantCollection`, `listQdrantCollections` (or delete if `/collections` is killed)
- `api/src/services/stores/interface.js:22-26` — `'baserow'` case
- `api/src/services/stores/interface.js:27-33` — `'none'` case (and its stale "Qdrant only" log)
- `api/src/routes/memory.js` — `observed_by`/`observation_count` corroboration branch (dedup returns early; branch is unreachable after v4 CANONICAL_AGENT coerce). Also the `stored_in: { qdrant: true }` response field at lines 68, 82, 101, 286.
- `mcp-server/src/index.js:347-379` — `brain_reclassify` tool definition
- `mcp-server/src/index.js:592-611` — `brain_reclassify` handler
- `mcp-server/src/index.js:403-428` — `brain_batch` tool definition
- `mcp-server/src/index.js:629+` — `brain_batch` handler (verify and delete)
- `api/package.json` — `"reindex"` script entry and `better-sqlite3` dependency (if SQLite dropped)

Comment/string cleanups (safe, cosmetic):
- `api/src/index.js:64`
- `api/src/services/relevance-scorer.js:36, 111, 137`
- `api/src/services/collection-registry.js:1, 15, 81`
- `api/src/services/consolidation.js:14, 21`
- `api/src/services/pgvector.js:3-4, 17, 199-200, 239, 347`
- `api/src/routes/briefing.js:25`
- `api/src/routes/export.js:23, 185, 236`
- `api/src/routes/entities.js:117-146` — rename `qdrantResult` → `vectorResult`, field names `qdrant_updated`/`qdrant_scanned` → `vector_updated`/`vector_scanned`
- `api/src/routes/collections.js:13, 14, 19, 21, 27, 51` — rename `qdrantCollections`, `qdrantNames`, `exists_in_qdrant`
- `docker-compose.production.yml:5, 15, 22-24` — remove Baserow network (if confirmed nothing on G6 uses it)

Confidence: **MEDIUM** — delete after one targeted verification step.

- SQLite backend (`api/src/services/stores/sqlite.js` + `'sqlite'` branches in `stores/interface.js`, `entities.js`, `keyword-search.js`, `routes/entities.js:99-102`; `better-sqlite3` dep) — verify no dev runs with `STRUCTURED_STORE=sqlite` first, then delete.
- `/collections` route + `collection-registry.js` + `collection` column (`api/src/routes/collections.js`, `api/src/services/collection-registry.js`, column-writes in `pgvector.js`) — verify nothing reads `/collections` (MCP doesn't; bash adapter doesn't; no in-tree clients do). Delete if confirmed.
- `MULTI_PATH_SEARCH` env var — consider promoting to always-on and deleting the flag.

Confidence: **LOW** — needs rewrite, not deletion.

- README.md — needs a v4 rewrite, not a delete.
- `mcp-server/src/index.js:44` version literal — switch to `pkg.version` import.
- `mcp-server/package.json` — bump version + rewrite description + drop stale keywords.
- `CLAUDE.md` (top-level, outside repo) — says Qdrant is used; the in-repo CLAUDE.md says pgvector. Out of scope for this audit but the top-level global CLAUDE.md in `~/.claude/CLAUDE.md` needs an update too ("Zengram — Shared Brain cross-agent memory system (Qdrant + Postgres). Deployed on G6:8084.").
