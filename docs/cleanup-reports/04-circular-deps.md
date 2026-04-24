# 04 — Circular Dependencies

## Summary

**Zero circular dependencies.** Madge analyzed all 37 JS files across `api/src` and `mcp-server/src` and reported `No circular dependency found!`. The import graph is a clean DAG.

There are no load-time cycles and no runtime-only cycles to document — the graph has neither.

## Tooling notes

- `npx madge --circular --extensions js api/src mcp-server/src` — **clean**. 37 files processed, 0 cycles.
- `npx madge --extensions js api/src` — full dependency graph captured in `/tmp/madge-graph.txt`. Manual inspection confirms no A→B→A patterns and no longer chains returning to origin.
- `npx madge --orphans --extensions js api/src mcp-server/src` — reports `api/src/index.js` and `mcp-server/src/index.js`. Both are process entry points (Express server / MCP stdio server). These are not true orphans — nothing should import them. Ignore.
- Warnings madge printed (8 of them) are all external packages it skips by design (`express`, `node-cron`, `openai`, `pg`, `better-sqlite3`, `@modelcontextprotocol/sdk/*`). Not relevant to cycle analysis.

## Findings (ordered by severity)

None. Nothing to fix.

## Observations worth noting (not findings)

A quick read of the graph confirms the architecture follows a clean layered pattern, which is why there are no cycles:

1. **Entry point → Routes → Services → Adapters** is strictly one-directional.
   - `api/src/index.js` imports routes and a few services.
   - Routes import services.
   - Services import other services and adapters.
   - Adapters (embedders/llm/stores providers) don't import services or routes.

2. **Provider-interface pattern is done correctly.** The three interface files
   - `api/src/services/embedders/interface.js`
   - `api/src/services/llm/interface.js`
   - `api/src/services/stores/interface.js`

   each import their concrete providers (e.g. `embedders/interface.js` imports `gemini.js`, `ollama.js`, `openai.js`). The concrete providers **do not** import the interface back. This is the textbook way to avoid the "factory ↔ implementation" cycle that plagues many plugin systems.

3. **No backward imports from leaf utilities.** `scrub.js`, `rrf.js`, `query-expander.js`, `relevance-scorer.js`, `temporal-resolver.js`, `keyword-search.js`, `entities.js`, `fetch-with-timeout.js`, and all store/llm/embedder leaves are pure downstream — they don't reach back up to routes or middleware.

4. **`mcp-server/src`** is a single file (`index.js`), so cycles are structurally impossible there.

## Orphan modules (not imported by anything)

Madge's orphan report flagged only the two process entry points:
- `/home/steven/dev/zengram/api/src/index.js`
- `/home/steven/dev/zengram/mcp-server/src/index.js`

Both are correct entry points (Express server and MCP stdio server, respectively). Not real orphans — do not delete, do not import.

The unused-code agent does not get any help from this pass. No truly-unused modules were surfaced by the orphans check. (Deeper dead-code analysis — unused exports within imported files — is out of scope for madge and belongs to that agent.)

## Non-findings

- The three `interface.js` fan-out files (`embedders/`, `llm/`, `stores/`) look superficially like they could cause cycles because they sit at the top of a provider tree. They don't. Each is a one-way router; the providers underneath don't import upward.
- `middleware/validate.js` appears with zero imports of its own — that's fine, it's a leaf utility imported by `routes/memory.js` and `routes/export.js`.

## Recommendation

No structural changes needed. The cleanup branch can skip this concern entirely. Spend the refactor budget elsewhere (e.g. the deferred Qdrant→pgvector migration mentioned in `CLAUDE.md`, or whatever the other numbered cleanup reports surface).
