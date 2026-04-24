# 01 — DRY / Deduplication

## Summary

This codebase is already reasonably factored. JSCPD (8-line / 60-token threshold) reports only **1.29% duplicated lines** (88 of 6811) across 37 files. Most of the "duplication" is either parallel-by-design (sqlite vs postgres backends speak different SQL dialects) or thin dispatch wrappers that legitimately exist to isolate a swap point (embedders, LLMs, stores).

Real DRY wins concentrate in three hotspots: the write-pipeline in `memory.js` + `export.js` + `consolidation.js` (scrub → hash → embed → upsert → keyword-index → entity-link → structured-store write is open-coded 4-5 times), the hybrid retrieval + RRF fusion block (duplicated memory.js ↔ reflect.js), and the entity-store availability guard in `entities.js` (same 400 response repeated 6 times). Realistic LOC savings from all findings together: **~130–180 lines**. This is not a codebase that needs a refactor — it needs targeted consolidation on 3-4 specific seams.

## Critical assessment

State is healthy. Dispatch wrappers in `services/embedders/interface.js`, `services/llm/interface.js`, and `services/stores/interface.js` might look like boilerplate, but they are the swap-point interfaces for provider pluggability — removing them would couple routes to concrete implementations. Don't touch those.

The write-pipeline duplication IS real and is the main find. `POST /memory`, `POST /export/import`, `consolidation.merged_facts`, and `consolidation.compressed_summaries` all run the same sequence (hash → dedup-check → embed → upsertPoint → keyword-index → structured-store write). The steps are the same; only the payload shape varies slightly per memory type. That's classic "three-plus occurrences of an identical pipeline" territory.

Everything else is minor hygiene.

## Findings (ordered by confidence)

### [HIGH] Content-hash computation is a one-liner duplicated 6× verbatim
- Locations: `api/src/routes/memory.js:50`, `api/src/routes/memory.js:698`, `api/src/routes/export.js:143`, `api/src/services/consolidation.js:285`, `api/src/services/consolidation.js:372`, `api/src/services/consolidation.js:434`
- What's duplicated: the exact same expression `crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)`
- Proposed consolidation: Add `export function contentHash(text) { ... }` to `api/src/services/scrub.js` (it already owns content-prep) or a new `api/src/services/hash.js`. Replace all 6 call sites.
- Risk: Near-zero — pure function, no behavior change. Only catch: confirm every caller truly uses the 16-char truncation (they do — verified).
- LOC saved: ~5 lines + removed `crypto` import in two files.

### [HIGH] Two near-identical merged-fact / compressed-summary blocks in consolidation.js
- Locations: `api/src/services/consolidation.js:282-363` (merged_facts) and `api/src/services/consolidation.js:431-511` (compressed_summaries)
- What's duplicated: ~60 lines each — identical content-hash / exact-dedup / embed / semantic-dedup / upsertPoint / keyword-index / structured-store-write sequence. Only differences are (a) `consolidation_type` metadata string, (b) whether source memories are superseded or just flagged `consolidated: true`, and (c) the iteration variable name (`fact` vs `summary`).
- Proposed consolidation: Extract `async function storeConsolidatedFact({ item, type, clientId, now, supersedeSources })` that handles the whole pipeline. Called from both loops. The two call sites shrink to ~10 lines each.
- Risk: Low. Both paths already share identical dedup/embed/store semantics — the extraction codifies that. Watch: the `metadata.consolidation_type` literal and the supersede-vs-mark-consolidated branch must remain parameterized correctly.
- LOC saved: ~50 lines (60 duplicated → helper of ~55 + two 5-line calls).
- JSCPD confirmed this as the largest in-file clone (19 lines, 191 tokens).

### [HIGH] Hybrid search + RRF fusion is open-coded in two routes
- Locations: `api/src/routes/memory.js:360-427` (~68 lines) and `api/src/routes/reflect.js:50-90` (~41 lines)
- What's duplicated: the multi-path dispatch (vector + keyword parallel fetch), RRF fusion call, payload-map assembly with fallback `getPoints` batch fetch for IDs missing from vector results, and the "fall through to vector-only" branch.
- Proposed consolidation: Extract `async function hybridSearch({ query, searchQuery, filter, limit, nestedFilters, rangeFilters, skipMultiPath })` → `{ results, vectorResults, keywordResults, retrievalSources }` in a new `api/src/services/hybrid-search.js`. Both routes call it; memory.js then layers its re-ranking / access-count-update on top.
- Risk: Medium. memory.js's version has extra features (entity-filter short-circuit via `skipMultiPath`, `retrievalSources` tracking, explicit handling of `getPoints` failure). The helper needs to return enough state for both callers. Hybrid-search tests already exist (they test RRF via the end-to-end route); add a unit test on the helper during extraction.
- LOC saved: ~35 lines. Also unblocks consistency — right now reflect.js silently swallows `getPoints` errors while memory.js logs them, which is a subtle drift.
- JSCPD confirmed the payload-map block as a clone (memory.js:408-416 ↔ reflect.js:77-84).

### [HIGH] Entity-store availability guard repeated 6× with two slight copy variants
- Locations: `api/src/routes/entities.js:14-18, 36-38, 50-52, 173-175, 200-202, 238-240, 320-322`
- What's duplicated: `if (!isEntityStoreAvailable()) return res.status(400).json({ error: 'Entity queries require sqlite or postgres backend.' });`. Line 14-18 uses a longer form with `.env` hint, the other 5 use the shorter form — drift.
- Proposed consolidation: Define `requireEntityStore(res)` helper (returns `true` if OK, sends 400 + returns `false` otherwise) at top of `entities.js`, OR an Express middleware applied to the router. Middleware is cleaner — `entitiesRouter.use((req, res, next) => isEntityStoreAvailable() ? next() : res.status(400).json({ error: '...' }))`. Note: `/stats` currently returns a graceful empty response instead of 400, so either exempt that route or convert it to use the middleware consistently.
- Risk: Low for the helper approach, minimal for middleware if you handle the `/stats` exception.
- LOC saved: ~18 lines + drift eliminated.

### [MEDIUM] Write-pipeline for POST /memory vs POST /export/import
- Locations: `api/src/routes/memory.js:147-278` and `api/src/routes/export.js:118-246`
- What's duplicated: building the Qdrant `payload` object, calling `scrubCredentials` + `contentHash` + `embed`, `upsertPoint`, fire-and-forget `indexMemory`, entity extraction + `linkExtractedEntities`, and the `storeData` build + dispatch (`event`/`decision` → `createEvent`, `fact` → `upsertFact`, `status` → `upsertStatus`).
- Proposed consolidation: Extract `async function writeMemory({ content, type, sourceAgent, clientId, category, importance, knowledgeCategory, metadata, key, subject, statusValue, pointId, now })` → `{ id, payload, contentHash }` in a new `api/src/services/memory-writer.js`. Both routes call it. The structured-store dispatch block (memory.js:259-277, export.js:210-239) is the cleanest sub-extraction — both do the exact same switch on `type`.
- Risk: Medium. `POST /memory` has extra logic (dedup-observed-by corroboration, supersedes chains, relevance scoring, event compression) that wraps the core write. Extract the core write but leave the pre/post logic in the route. Import path has slightly more permissive defaults (e.g. `source_agent = 'import'`); the helper must accept all these as parameters without special-casing the caller.
- LOC saved: ~40 lines if just the structured-store-dispatch block is extracted; ~80+ if the whole pipeline is unified. Start with the structured-store block — it's the clearest, lowest-risk win.

### [MEDIUM] `{ createEntity, findEntity, linkEntityToMemory, createRelationship }` dependency bag
- Locations: `api/src/routes/memory.js:239`, `api/src/routes/memory.js:734`, `api/src/routes/export.js:203`
- What's duplicated: `linkExtractedEntities` takes a dependency-injection object with the same 4 functions, reconstructed at each call site. The imports are also duplicated (`memory.js:10`, `export.js:7`).
- Proposed consolidation: Either (a) have `linkExtractedEntities` import those directly from `stores/interface.js` — the DI was probably there for testability, but tests can still mock the module; or (b) export a pre-bound `const entityStoreOps = { createEntity, findEntity, linkEntityToMemory, createRelationship }` from `stores/interface.js`. Option (a) is cleaner.
- Risk: Low. Check `api/tests/` for tests that pass mocks through this bag before simplifying (quick grep — if none mock it, option (a) is free).
- LOC saved: ~10 lines + 2 imports simplified.

### [LOW] Embedder/LLM provider-registry dispatch shape is parallel
- Locations: `api/src/services/embedders/interface.js:9-42` and `api/src/services/llm/interface.js:8-34`
- What's duplicated: the switch-statement-with-dynamic-import pattern, the `provider = null` singleton, the `getXInfo()` return shape.
- Proposed consolidation: Could extract `createProviderRegistry({ envVar, registry, validate })` → `{ init, get, getInfo }`. But this is "shared shape in different contexts" — embedders validate with a test embed call, LLMs don't. They have different method signatures on the provider (`.embed` vs `.complete`). A generic factory would need enough parameters that it probably won't reduce net complexity.
- Proposed action: **Leave alone.** The parallel shape is the interface. Two 45-line dispatchers are easier to read than one 60-line abstract factory plus two registration files.
- LOC saved: negative once you count the abstraction overhead.

### [LOW] `getPoint` → 404-or-proceed pattern in memory.js PATCH and DELETE
- Locations: `api/src/routes/memory.js:676-687` and `api/src/routes/memory.js:765-775`
- What's duplicated: `let point; try { point = await getPoint(id); } catch { return res.status(404)... } if (!point || !point.payload) return res.status(404)...`
- Proposed consolidation: `async function requirePoint(id, res)` → returns point or sends 404 + returns null.
- Risk: Zero.
- LOC saved: ~10 lines.
- JSCPD flagged this as a clone (11 lines, 117 tokens).

## Non-findings (patterns I considered and rejected)

- **sqlite.js ↔ postgres.js listEvents/listFacts/listStatuses:** Shape is identical but the SQL is dialect-specific (`@param` vs `$1`, `LIKE` vs `ILIKE`, `INSERT OR REPLACE` vs `ON CONFLICT`). Extracting would require a query-builder abstraction that's strictly worse than having two concrete implementations side-by-side. Leave alone.
- **`res.status(500).json({ error: 'Internal server error' })` — 25 occurrences:** An Express error-handler middleware could centralize this, but the current explicit `try/catch` inside each route handler makes the contextual `console.error('[route:name]', err.message)` tag easier to write and harder to forget. The logging tag is the real value; the 500 send is incidental. An Express global error handler would lose the per-route tag. Leave.
- **Provider wrappers `embedders/openai.js`, `embedders/gemini.js`, `embedders/ollama.js`:** They look similar (constructor → `.embed()` → `.getDimensions()`) but each one's `.embed` body is very different (official SDK call vs raw fetch + Gemini task-type header vs Ollama's batch response unwrap). The shared interface IS the shape; they're not duplicates of each other.
- **`stats.js` try/catch-ignore blocks (3×):** Each is 5–9 lines and touches a different API. A generic `safeAsync(fn, fallback)` helper would save line count but obscure the intent. Leave.
- **MCP `URLSearchParams` builder boilerplate (8 cases in `mcp-server/src/index.js`):** Individual URL-param construction is small and each query takes different params. A shared builder would need a per-tool allowlist that's no shorter than the inline code.
- **Auth rate-limit logic + overall rate-limit logic (middleware/auth.js + middleware/ratelimit.js):** Both implement bucket-per-key + `setInterval` cleanup, but they limit different things (failed-auth attempts per IP vs authenticated requests per key) with different policies. Unifying would require enough configuration that the shared base would be longer than the two specific implementations.

## Recommended order of operations

1. **`contentHash` helper** — one-liner extraction, zero risk, unblocks the next finding.
2. **`requirePoint` helper in memory.js** — pure cleanup, no cross-file changes.
3. **Entity-store availability guard (middleware or helper)** — localized to entities.js.
4. **Consolidation.js merged-fact / compressed-summary extraction** — single-file change, high payoff.
5. **Hybrid-search extraction** — needs a new service file; test both callers after.
6. **Structured-store-dispatch block in memory.js + export.js** — the smallest slice of the write-pipeline finding; extract that first before attempting a fuller `writeMemory` helper.
7. (Optional, only if tests allow) `linkExtractedEntities` dep-injection simplification.

Steps 1-4 are independent and can be done in any order. Steps 5 and 6 are the higher-risk changes — do them last, after the no-risk wins have built confidence and shrunk the affected files.
