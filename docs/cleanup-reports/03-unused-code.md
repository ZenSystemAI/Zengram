# 03 — Unused Code

## Summary

Zengram v4 is **lean**, not bloated. The recent v3 → v4 refactor (commits 3c219c6, 126cb44, fba444c) already deleted the bulk of the dead weight — per-agent auth, graph BFS, several route handlers, OpenClaw/n8n adapters, the SDKs. The `sdk/` directory is now an empty stub.

What remains:

- **Zero fully unused files.** Every `.js` under `api/src/` is imported by something reachable from `api/src/index.js` or `api/tests/`. Every route is mounted. Every middleware is used. Every service has at least one external consumer. The dynamically-loaded provider backends (embedders, LLMs, stores) look "unreferenced" by grep-for-imports but are loaded via `import('./provider.js')` in the three `interface.js` dispatchers — not dead.
- **~17 unused exports** across 7 files, totalling roughly **60–90 LOC of dead export surface**. Most are either (a) shim functions left behind by the v4 simplification, (b) diagnostic `getXInfo()` helpers for removed health/stats features, or (c) validate.js helpers that used to be called per-field and are now only called as a chain inside `validateMemoryInput`.
- **9 maintenance scripts** in `api/scripts/` that are not imported (expected — they're operator CLI tools). Only `reindex-embeddings.js` is wired via `npm run reindex`. The others have docstrings explicitly declaring them as manual/cron entry points. These are **not** dead code.

Estimated dead LOC if every flagged export were deleted (including function bodies where the whole function is unreachable): **~60 LOC in service files + ~25 LOC of export statements = ~85 LOC**. Against a 4,525-LOC `api/src` tree, that's 1.9%. Lean.

## Critical assessment

This codebase is **reasonably lean**. The v4 cleanup has already removed the obvious dead routes, services, and SDKs — what's left is residue from that same pass: shims that nothing calls anymore, and internal helpers that got `export` keywords during early refactors and never had the `export` removed when their external callers went away.

No Rule 2 "fully dead files" to delete. No hidden import graphs. The three-way `interface.js` dynamic dispatch (embedders/llm/stores) is a deliberate plugin pattern, not dead code — all provider implementations are loaded based on env vars.

The one genuine smell is `api/src/services/relevance-scorer.js:24` (`updateSourceTrust`) — the v4 CLAUDE.md confirms `feedback-loop.js` was removed, and `updateSourceTrust` was that loop's only caller. The function is now orphaned but harmless. Same story for `initQdrant()` in `pgvector.js` — an explicit "shim for backward-compat" that nothing actually needs anymore.

Recommend: clean up the 17 unused exports in a single cosmetic pass (can be one commit). Leave the maintenance scripts alone.

## Tooling notes

Knip worked, but with caveats:

- **Ran it from `api/` and `mcp-server/` separately** (not root) because there's no root `package.json`. Root invocation fails with "Unable to find package.json". Workspaces config would fix this.
- **Caveat on reporting scope**: knip only flagged `exports` — it did **not** flag any `files` as unused. For a layout with scripts, adapters, and examples outside the api workspace, that's expected but incomplete. I cross-checked manually: no unused `.js` files.
- **Knip correctly did not flag**: dynamically-imported provider files (embedders/*, llm/*, stores/*) — the dynamic `import()` in `interface.js` kept them alive in its graph. Good.
- **Knip's mcp-server run returned `{"issues":[]}`** — the MCP server file is a single flat module, so there are no internal-export concerns.
- **Knip did not inspect `api/scripts/`** by default, which is correct — they're standalone entry points and would be false positives.

## Findings (ordered by confidence)

### [HIGH] Unused export: `initQdrant` in pgvector.js

- Path: `api/src/services/pgvector.js:100`
- Evidence: `grep -rn "initQdrant" --include="*.js" .` returns only the definition. The function's own comment reads "Shim for backward-compat with imports from index.js. Calls initPgvector." — but `index.js` imports `initPgvector`, not `initQdrant` (verified `grep -n "initPgvector\|initQdrant" api/src/index.js`). No adapter, example, doc, or test references it.
- Risk of deletion: **LOW** — function body just calls the correctly-named `initPgvector`. Deleting removes a confusing shim.

### [HIGH] Unused export: `closePgvector` in pgvector.js

- Path: `api/src/services/pgvector.js:444`
- Evidence: `grep -rn "closePgvector" --include="*.js" .` returns only the definition. Comment says "for graceful shutdown — tests" but no test imports it; `api/tests/*.test.js` do not reference it.
- Risk of deletion: **LOW–MEDIUM**. Pool cleanup would technically leak a connection if node process doesn't exit cleanly, but since the API runs as a persistent server and tests don't use Postgres directly, this is unused infrastructure. Could alternatively be wired into a `SIGTERM` handler in `index.js` if you want it — keep if you want graceful shutdown later.

### [HIGH] Unused export: `updateSourceTrust` in relevance-scorer.js

- Path: `api/src/services/relevance-scorer.js:24`
- Evidence: `grep -rn "updateSourceTrust" --include="*.js" .` returns only the definition. The companion `getSourceTrust` IS used internally at line 85 (`scoreRelevance`), but `updateSourceTrust` has no caller anywhere. The CLAUDE.md v4 notes explicitly list `feedback-loop` service as **removed** — and the feedback loop was the only place that wrote to `sourceTrustCache`. The cache is now permanently empty, making line 85 a no-op that always returns the default `0.5`.
- Risk of deletion: **LOW** — the cache it populates is currently inert. Can either delete `updateSourceTrust` and simplify `getSourceTrust` to `return 0.5`, or leave both in place as documented future-extension points.

### [HIGH] Unused exports: `isKnownCollection`, `getCollectionConfig`, `getCollectionIndexes` in collection-registry.js

- Path: `api/src/services/collection-registry.js:69, 83, 98`
- Evidence: `grep -rn` returns only the definitions. The `routes/collections.js` file imports *six* other functions from collection-registry (`resolveCollection`, `validateCollectionSlug`, `registerCollection`, `unregisterCollection`, `listCollections`, `getDefaultCollection`) but none of the three above. `getCollectionConfig` and `getCollectionIndexes` look like they were written to let callers lazily build a new collection; `createQdrantCollection` in `pgvector.js` doesn't import them — it builds the config inline.
- Risk of deletion: **MEDIUM** — if the Qdrant → pgvector migration (deferred per CLAUDE.md) ever wants to standardize collection bootstrapping, these would be useful. But as-written they're not called from anywhere. Safe to delete; re-add from git history if needed.

### [HIGH] Unused exports: `extractTopic`, `getPreferenceKeywords`, `generateSubQueries` in query-expander.js

- Path: `api/src/services/query-expander.js:151, 176, 196`
- Evidence: `grep -rn "extractTopic\|getPreferenceKeywords\|generateSubQueries"` returns only internal cross-references inside `query-expander.js` itself (e.g. `getPreferenceKeywords` calls `extractTopic`). Externally, only `analyzeQuery`, `expandQuery`, and `extractSearchTerms` are imported (by `routes/memory.js:313–574`). The three flagged exports form an internal cluster that no route invokes. Note that `docs/cleanup-reports/05-weak-types.md:95` mentions `getPreferenceKeywords` as "internal" — suggesting it was planned as a path but never wired up.
- Risk of deletion: **MEDIUM** — if a future `search` handler wants preference-query sub-query expansion (a real algorithmic improvement the code documents), these are the scaffold. But nothing uses them today. You can either (a) delete and re-derive when needed, or (b) keep and drop the `export` keyword since there's no external consumer.

### [HIGH] Unused exports: `validateKnowledgeCategory`, `validateClientId`, `validateTemporalFields`, `VALID_TYPES`, `VALID_IMPORTANCE` in validate.js

- Path: `api/src/middleware/validate.js:55, 68, 72, 105, 105`
- Evidence: `grep -rn "validateKnowledgeCategory\|validateClientId\|validateTemporalFields"` shows these are called only *inside* `validateMemoryInput` (same file, lines 95–101) — no external import. `VALID_TYPES`/`VALID_IMPORTANCE` from this module are imported nowhere; `consolidation.js:274` and `routes/entities.js:61` re-declare their own local `VALID_IMPORTANCE` / `VALID_TYPES` arrays (flagged in report 02 as a DRY issue).
- Risk of deletion: **LOW** — but **don't** simply delete. Report 02 recommends *importing* `VALID_TYPES` / `VALID_IMPORTANCE` into consolidation.js and routes/entities.js instead of re-declaring. That fix *uses* the exports and resolves both the unused-export warning and the DRY violation in one pass. For the three helper `validate*` functions, dropping the `export` keyword is safe (they stay callable internally from `validateMemoryInput`).

### [MEDIUM] Unused export: `getStoreInfo` in stores/interface.js

- Path: `api/src/services/stores/interface.js:72`
- Evidence: `grep -rn "getStoreInfo"` returns only the definition. Compare to `getLLMInfo` (at `llm/interface.js:41`) which IS used by `routes/reflect.js:148` and `services/consolidation.js:163,610`. The pattern was "every interface.js exports a diagnostic info function" but only `getLLMInfo` got wired into routes.
- Risk of deletion: **LOW** — mirror-image of `getLLMInfo`, probably intended for a `/health` or `/stats` surface that never landed. Could be wired into `routes/stats.js` if you want introspection on the current backend.

### [MEDIUM] Unused exports: `getEmbeddingInfo`, `EMBEDDING_DIMS` in embedders/interface.js

- Path: `api/src/services/embedders/interface.js:54, 63`
- Evidence: Same story as `getStoreInfo`. `grep -rn` returns only the definitions. `EMBEDDING_DIMS` is explicitly documented as "Backwards compatibility export … Will be set dynamically after init" but nothing consumes it — external callers that need the dim value use `getEmbeddingDimensions()` directly. `EMBEDDING_DIMS` is permanently `null`.
- Risk of deletion: **LOW** — `EMBEDDING_DIMS = null` is load-bearing only as an API surface promise nothing depends on. `getEmbeddingInfo` could be wired into a /stats route or deleted.

### [MEDIUM] Unused exports: `getRelationships`, `listRelationships` in stores/interface.js

- Path: `api/src/services/stores/interface.js:120, 124`
- Evidence: `grep -rn "getRelationships\|listRelationships"` shows the underlying backend methods in `stores/sqlite.js:421,444`, `stores/postgres.js:365,392`, and no-op stubs in `stores/baserow.js:124,125`. The dispatcher wrappers in `interface.js` are **not** called from anywhere. The original graph routes (`/graph`, etc.) that would have called these were removed in v4 per CLAUDE.md.
- Risk of deletion: **MEDIUM** — the underlying backend methods still exist (Postgres/SQLite both implement them). If you fully commit to "graph BFS is gone", delete the interface wrappers AND the backend methods. If you want to leave the door open for future graph work, keep both. Current state (wrappers dead, backends live) is the middle road — consistent, but unused.

## Non-findings (things that LOOK unused but aren't)

- **`api/src/services/embedders/{openai,gemini,ollama}.js`**, **`api/src/services/llm/{openai,anthropic,gemini,ollama}.js`**, **`api/src/services/stores/{sqlite,postgres,baserow}.js`** — No static `import` references them by exact path, but each is loaded via `await import('./provider.js')` inside the matching `interface.js` dispatcher (`embedders/interface.js:11–27`, `llm/interface.js:10–32`, `stores/interface.js:10–33`) based on env vars (`EMBEDDING_PROVIDER`, `CONSOLIDATION_LLM`, `STRUCTURED_STORE`). All live at runtime.
- **`api/scripts/*.js`** (all 9 scripts) — Not imported anywhere except `reindex-embeddings.js` via `npm run reindex`. But every script has an explicit `#!/usr/bin/env node` shebang and a usage docstring documenting cron or manual invocation. `status-staleness.js` and `tier2-compression.js` document specific crontab entries. `backfill-qdrant-to-pgvector.js` is explicitly the migration script referenced in CLAUDE.md's "deferred Qdrant → pgvector migration" note. `cleanup-duplicates.js`, `cleanup-garbage-entities.js`, `rebuild-from-postgres.js`, `backfill-entities.js`, `backfill-keyword-index.js` are operator CLIs. None of these are dead code — they're intentionally-standalone maintenance tools.
- **`api/scripts/migrate-v4-dedupe.sql`**, **`scripts/v4-migrate-qdrant-payloads.md`**, **`scripts/v4-migrate-source-agent.sql`** — Referenced from `CHANGELOG.md:12` as migration assets for the v4 transition. Not dead.
- **`sdk/` directory** — Exists as an empty stub after CLAUDE.md's v4 removal of Python and TypeScript SDKs. No `.js` files to flag, but the directory should probably be deleted to keep the repo tidy (out of scope for this report — it's not unused *code*, it's an empty folder).
- **`adapters/bash/brain.sh`**, **`adapters/claude-code/sessionend/SKILL.md`**, **`adapters/bash/SKILL.md`** — External integration surface, not imported by any JS. These are user-facing adapter files.
- **`examples/curl-demo.sh`**, **`examples/python-client.py`**, **`examples/multi-agent-scenario.sh`** — User-facing demo/documentation scripts.
- **`api/src/middleware/validate.js` — `validateSourceAgent`, `validateType`, `validateContent`, `validateImportance`, `validateMetadata`, `validateStringField`** — Knip didn't flag these (correctly): they ARE imported externally (by `api/tests/validate.test.js:3–11`) even though runtime code only calls them via the `validateMemoryInput` composition. The test usage keeps them alive.
- **`api/src/services/pgvector.js` — `DECAY_TYPES`** — Exported via `export { DECAY_TYPES }` at line 451 and imported by `routes/stats.js:2` for the `affected_types` field in a response. Live.
- **`api/src/services/entities.js` — `addToAliasCache`** — Only 3 file references (internal + `routes/entities.js`). Legitimately used when processing alias updates from the reclassify handler.
