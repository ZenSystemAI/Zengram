# 02 — Type Definitions

## Summary

Almost no real debt here. Zero `@typedef` blocks, zero `@type` annotations, zero `.ts`/`.d.ts` files, no Ajv/Joi/Zod schemas. The v4 pass cleanly removed the TypeScript SDK and left a pure-JS codebase that documents its shapes informally through:

1. Inline comments at the top of each `interface.js` (stores, embedders, llm) describing the contract every provider must implement.
2. Hand-rolled field validators in `api/middleware/validate.js`.
3. JSON Schema embedded in `mcp-server/src/index.js` per MCP protocol requirements.

The only concrete finding is three enum literal arrays duplicated across three files. Everything else is already appropriately un-abstracted for a 37-file JS codebase.

## Critical assessment

This is a small JS service. Introducing a `types.js` module just to hold shape comments would be theater — JSDoc `@typedef` gives you nothing at runtime, and the IDE's inference is already picking up shapes from destructures like `const { type, content, source_agent, ... } = req.body` in `routes/memory.js`. The interface files already serve as the informal type documentation they should. The one place where "consolidation" would pay for itself is deduplicated enum arrays (`VALID_TYPES`, `VALID_IMPORTANCE`, `VALID_KNOWLEDGE_CATEGORIES`) — and those are already centralized in `validate.js`; a separate service file just needs to import from there. Do not invent a `types.js`. Do not introduce TypeScript. Do fix the one hand-copied enum list.

## Findings (ordered by confidence)

### HIGH `VALID_KNOWLEDGE_CATEGORIES` and `VALID_IMPORTANCE` re-declared inside consolidation.js

- Locations + evidence:
  - `/home/steven/dev/zengram/api/src/middleware/validate.js:4-6` — the canonical declarations with `export { VALID_TYPES, VALID_IMPORTANCE }`.
  - `/home/steven/dev/zengram/api/src/services/consolidation.js:266` — re-declares `VALID_KNOWLEDGE_CATEGORIES` locally.
  - `/home/steven/dev/zengram/api/src/services/consolidation.js:274` — re-declares `VALID_IMPORTANCE` locally.
  - `validate.js` already exports `VALID_TYPES` and `VALID_IMPORTANCE`; it does not currently export `VALID_KNOWLEDGE_CATEGORIES` though it is a top-level const.
- Proposed consolidation: add `VALID_KNOWLEDGE_CATEGORIES` to the `export { ... }` line at `validate.js:105`, then import both arrays from `../middleware/validate.js` inside `consolidation.js`. Net change: ~3 lines.
- Risk: trivially low. The values are identical today; the concern is drift if someone adds a category to one place and forgets the other.

### MEDIUM MCP input schemas duplicate the same enum values

- Locations + evidence: `/home/steven/dev/zengram/mcp-server/src/index.js:58,80,97,124,150,306,311,329,414,419` — the same `['event','fact','decision','status']`, `['critical','high','medium','low']`, and `['brand','strategy','meeting',...]` literals appear 2–4 times each inside tool `inputSchema` objects.
- Proposed consolidation: hoist three `const TYPE_ENUM = [...]`, `IMPORTANCE_ENUM`, `KNOWLEDGE_CATEGORY_ENUM` to the top of `mcp-server/src/index.js`, reference them inside each `inputSchema`. Do NOT import from the API package — `mcp-server/` is a separate publishable npm package (`@zensystemai/zengram-mcp`) and must not take a cross-package dependency on `api/src/`. A local const at the top of the file is the right scope.
- Risk: low. MCP protocol requires the JSON Schema literal, so the enum still lives in this file — we're just deduping within one file.

## Non-findings

- **The `data` shape passed to `createEvent`/`upsertFact`/`upsertStatus`** across `stores/postgres.js`, `stores/sqlite.js`, `stores/baserow.js` is NOT duplication worth fixing. This is the storage backend interface; the "type" is the SQL column list in each backend, and a JSDoc `@typedef` would just restate what the column list already documents. The inline comment at `stores/interface.js:1-2` already documents the contract: "Each backend must implement: createEvent, listEvents, upsertFact, listFacts, upsertStatus, listStatuses, healthCheck".
- **The `embedder.embed(text, purpose)` and `llm.complete(prompt, options)` shapes** are already documented in-file at `embedders/interface.js:2` and `llm/interface.js:2`. That is the right level of formality for two-argument provider contracts.
- **`req.body` destructures in routes** (e.g. `routes/memory.js:33`) look like repeated shape definitions but each route destructures a different subset for a different HTTP verb. There is no single "Memory" type that would fit all of them — POST takes input, the store returns different shapes, Qdrant payloads have additional fields like `observed_by` and `content_hash` that never appear in input. Forcing one typedef would be lossy.
- **Middleware validators** are a good hand-rolled validator module, not a schema library in disguise. Adding Ajv/Zod would be ~15 KB of dependency to replace 100 lines of clear, single-purpose code. Keep it.

## Should this codebase have a types.js / types.d.ts?

**No.** Reasoning:

1. **Size doesn't justify it.** 37 JS files, ~6800 lines total. JSDoc typedefs add ceremony without runtime safety and with negligible IDE benefit at this scale — destructure-based inference already works.
2. **The interface contracts are already co-located with the adapter code** that must satisfy them. `stores/interface.js`, `embedders/interface.js`, `llm/interface.js` each live next to their implementations. Moving those shapes to a central `types.js` would split documentation from the code it describes.
3. **No external consumers.** v4 removed the TS SDK and Python SDK — the MCP server is the only integration path, and it publishes its own schema via MCP protocol. There is no downstream that would benefit from shared type exports.
4. **A `.d.ts` file is strictly worse than nothing here** — it creates the illusion of type safety without a typecheck step, and nothing currently consumes ambient types.

The two small consolidations in the Findings section (share the enum arrays) are worth 5 minutes. Anything beyond that is invented infrastructure.
