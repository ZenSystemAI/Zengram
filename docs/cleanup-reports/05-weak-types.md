# 05 — Weak Types

## Summary

Zengram is plain ES modules — no TypeScript, no JSDoc typedefs, and (contrary to the task brief) **no AJV**. The codebase uses three validation layers:

1. **Express routes**: hand-rolled validators in `api/src/middleware/validate.js` (predicate-returning functions: `validateType`, `validateContent`, `validateMetadata`, `validateTemporalFields`, etc.). No schema library — just `typeof`/`Array.isArray`/regex checks composed into `validateMemoryInput(req.body)`.
2. **MCP server**: the one place with real schemas — each tool in `mcp-server/src/index.js` declares JSON Schema `inputSchema` objects with `enum`, `required`, and `type`. This is type-checked by the MCP client before it even hits the handler.
3. **Everything else**: `JSON.parse(...)` / `res.json()` results flow into code as bag-of-properties with `?.` guards.

So "weak typing" here really means: (a) JSDoc that declares `@param {object}` instead of a named shape, (b) LLM-returned JSON walked with optional chaining instead of a validated shape, and (c) Express routes that bypass the existing validator bank.

## Critical assessment

**Not N/A, but small.** The project has maybe 3–4 concrete spots where a shape contract would have caught (or still could catch) a real bug. The biggest is that `PATCH /memory/:id` silently skips `validateMemoryInput` entirely — a writer passing `importance: "urgent"` or `metadata: "string"` gets their garbage persisted. The second-biggest is `POST /export/import`, which validates a trimmed subset and then shovels raw `record.*` fields into `payload`. The LLM-response paths (`consolidation.js`, `reflect.js`) are defensive enough that invalid shapes degrade gracefully — they're not bug sources today, but one new field in the prompt and they will be.

Everything `POST /memory`, `POST /entities/reclassify`, `POST /consolidate`, `POST /collections` calls is already validated. Don't re-flag those.

## Findings (ordered by confidence)

### [HIGH] PATCH /memory/:id bypasses validateMemoryInput entirely

- **Location**: `api/src/routes/memory.js:665-757`
- **Current state**: The handler destructures `{ content, importance, knowledge_category, metadata }` from `req.body` and only checks that at least one is present (line 671). It then assigns them directly into `updatedPayload` without calling any of the validators that already live in `validate.js`. A client can `PATCH` with `importance: "urgent"`, `knowledge_category: "whatever"`, `metadata: "string-not-object"`, or a 50 MB deeply nested metadata blob, and the payload is merged and `upsertPoint`-ed with no complaint. This is the same request shape `POST /memory` validates — the rules exist, they just aren't invoked here.
- **Proposed tightening**: Call the existing validators before `updatePointPayload`:
  ```js
  if (content !== undefined) { const e = validateContent(content); if (e) return res.status(400).json({ error: e }); }
  if (importance !== undefined) { const e = validateImportance(importance); if (e) return res.status(400).json({ error: e }); }
  if (knowledge_category !== undefined) { const e = validateKnowledgeCategory(knowledge_category); if (e) return res.status(400).json({ error: e }); }
  if (metadata !== undefined) { const e = validateMetadata(metadata); if (e) return res.status(400).json({ error: e }); }
  ```
  No new schema library needed — the functions are already exported.
- **Risk**: Low. Adding 400s on previously-accepted-but-invalid requests could surface a malformed caller, but any such caller was already writing bad data to the store — failing fast is the improvement.

### [HIGH] POST /export/import trusts record shape after a partial validation pass

- **Location**: `api/src/routes/export.js:91-254` (especially lines 127-134, 162-183)
- **Current state**: `validateMemoryInput` is called with only five fields (`type, content, source_agent, importance, client_id`). The handler then builds a full payload from `record.key`, `record.subject`, `record.knowledge_category`, `record.category`, `record.confidence`, `record.access_count`, `record.active`, `record.superseded_by`, `record.entities`, `record.observed_by`, `record.observation_count`, `record.consolidated`, `record.metadata` (via entity extraction), etc. — none of which are validated. A malicious or corrupted export file can inject:
  - `entities: "not-an-array"` → later `payload.entities.map(...)` crashes on read or the stored shape breaks `batchUpdateEntityType` in `pgvector.js:400`.
  - `observed_by: {}` → breaks the corroborate path in `memory.js:56-91` next time the content is re-posted.
  - `knowledge_category: "lolsql"` → passes the filter on read, pollutes `/stats` and `/briefing` grouping.
  - `confidence: "high"` → later arithmetic (`score * effectiveConfidence * …`) silently becomes `NaN`.
- **Proposed tightening**: Run the full `validateMemoryInput` on every record (including metadata, knowledge_category, temporal fields), and add two cheap guards:
  ```js
  if (record.entities !== undefined && !Array.isArray(record.entities)) continue;
  if (record.observed_by !== undefined && !Array.isArray(record.observed_by)) continue;
  if (record.confidence !== undefined && typeof record.confidence !== 'number') continue;
  ```
- **Risk**: Low. Import is an admin/ops surface, so stricter validation just turns silent corruption into visible `errors++`.

### [MEDIUM] LLM-returned JSON is walked with optional chaining, not validated

- **Location**: `api/src/services/consolidation.js:218-272` (and similar pattern in `api/src/routes/reflect.js:122-141`)
- **Current state**: After `JSON.parse(responseText)`, the code checks only the top-level shape (`typeof result === 'object' && !Array.isArray(result)`), then walks `result.merged_facts`, `result.contradictions`, `result.connections`, `result.compressed_summaries`, `result.knowledge_categories` with `?.length`. Inside those arrays, `fact.content` is passed to `crypto.createHash(...).update(content)` — if `content` is `undefined` or a number, the hash call throws and the whole consolidation batch aborts. `fact.source_memories.filter(...)` assumes it's an array (line 240). The `reflect.js` path is better (it has `ensureArray` and `typeof reflection.summary === 'string'` coercion at line 134-141).
  - `reflect.js` already validates — leave it.
  - `consolidation.js` does partial validation (filters IDs, sanitizes importance) but trusts `fact.content`, `summary.content`, `contradiction.description`, `contradiction.suggested_resolution`, `connection.relationship` are strings.
- **Proposed tightening**: Add a per-item guard at the top of each loop in `consolidation.js`:
  ```js
  for (const fact of result.merged_facts) {
    if (typeof fact?.content !== 'string' || !fact.content.trim()) continue;
    if (fact.source_memories && !Array.isArray(fact.source_memories)) fact.source_memories = [];
    // … existing logic
  }
  ```
  A tiny JSDoc typedef above the function documents the contract for the next reader:
  ```js
  /**
   * @typedef {Object} ConsolidationResult
   * @property {Array<{content:string, key?:string, importance?:string, source_memories?:string[], client_id?:string}>=} merged_facts
   * @property {Array<{memory_a:string, memory_b:string, description:string, suggested_resolution:string}>=} contradictions
   * @property {Array<{memories:string[], relationship:string}>=} connections
   * @property {Array<{content:string, key?:string, importance?:string, source_memories:string[], client_id?:string}>=} compressed_summaries
   * @property {Array<{memory_id:string, suggested_category:string}>=} knowledge_categories
   */
  ```
- **Risk**: Low. These are cheap defensive checks; worst case one malformed LLM item is skipped instead of crashing the batch.

### [MEDIUM] Embedder provider responses are indexed without shape checks

- **Location**: `api/src/services/embedders/gemini.js:46-47`, `api/src/services/embedders/ollama.js:31`, `api/src/services/embedders/openai.js` (same pattern)
- **Current state**: `const data = await response.json(); return data.embedding.values;` — if the Gemini API changes shape or returns an error object with 200 status (rare but it happens when quota is soft-limited), you get `Cannot read properties of undefined (reading 'values')` which is then wrapped in the generic 500 handler upstream. The init-time validation in `interface.js:35` catches providers that are completely broken, but doesn't help with per-request shape drift.
- **Proposed tightening**: One guard per provider:
  ```js
  const data = await response.json();
  if (!data?.embedding?.values || !Array.isArray(data.embedding.values)) {
    throw new Error(`Gemini embed returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.embedding.values;
  ```
- **Risk**: Low. The error message becomes actionable instead of cryptic.

### [LOW] JSDoc `@param {object} filters` and `@param {object} analysis` obscure the contract

- **Location**: `api/src/services/keyword-search.js:75`, `api/src/services/query-expander.js:173, 193`, `api/src/services/relevance-scorer.js:38`
- **Current state**: The doc comment says `@param {object} filters - { client_id, type, source_agent }` — fine if you read it, but the function has no enforcement. `analyzeQuery` returns a documented shape (`{ isVague, isPreference, domain?, expansions?, originalQuery }`) but callers of `getPreferenceKeywords(query, analysis)` can pass any object and the function only checks `analysis.isVague` / `analysis.isPreference`. Not a bug source today; the callers are internal.
- **Proposed tightening**: Convert to JSDoc typedefs so editor tooling surfaces the shape:
  ```js
  /** @typedef {Object} QueryAnalysis
   * @property {boolean} isVague
   * @property {boolean} isPreference
   * @property {string=} domain
   * @property {string[]=} expansions
   * @property {string} originalQuery
   */
  ```
- **Risk**: None — documentation only.

## Non-findings

Places that looked weak but are fine:

- **`POST /memory`, `POST /entities/reclassify`, `POST /consolidate`, `POST /collections`** — all validated before the handler logic runs. Post-validate, the destructured values are as typed as hand-rolled JS gets.
- **`reflect.js` LLM JSON handling** — `ensureArray()` + per-field `typeof` coercion at lines 134-141 is exactly the right defensive shape for LLM output. Don't touch.
- **MCP server argument validation (`mcp-server/src/index.js:440+`)** — the `typeof args.type !== 'string'` checks look redundant given the MCP client pre-validates against `inputSchema`, but they're a belt-and-suspenders server-side check against a misbehaving client. Keep them.
- **`scrubObject` recursing on unknown shapes** — the `typeof obj === 'object'` / `Array.isArray` branching in `scrub.js:32-44` is correct recursion on arbitrary JSON, not a sign of missing contract. This is the one place "accepts anything" is actually the requirement.
- **`validateMetadata` rejecting non-plain-objects** — the `typeof metadata !== 'object' || Array.isArray(metadata)` check at `validate.js:48` is the validation, not a missing one.
- **`Array.isArray` in `pgvector.js:292, 400`** — defensive reads of JSONB payloads from Postgres where the column is `jsonb` and historic rows may differ. The looseness is the point.

## Meta-recommendation

**No, don't migrate to TypeScript.** Reasons:

1. The surface area is tiny — maybe 25 files under `api/src/`. The gain from static types on a codebase this size doesn't justify the build-step tax (tsc, tsconfig, source maps for Docker, updated `package.json` scripts, updated test runner).
2. The one place that genuinely needs schema enforcement (user-submitted HTTP bodies) already has hand-rolled validators that work. Adding TypeScript would not have caught any of the findings above — `PATCH /memory/:id` bypassing the validator is a runtime logic bug, not a type bug. TypeScript would see `req.body` as `any` and shrug.
3. The LLM-response handling is the other hot spot, and TypeScript doesn't help there either. `JSON.parse` returns `any`. You'd need `zod` or equivalent for runtime validation — which is exactly what the proposed per-item guards above are, minus the dependency.
4. The MCP server's JSON Schema inputs already give the only external caller (Claude Code) a typed interface for free. That's the one integration boundary that matters, and it's covered.

**Instead, do two things within the JS paradigm:**

- Fix the PATCH /memory/:id bypass (one commit, ~10 lines).
- Add JSDoc `@typedef` blocks above `consolidation.js`'s `runConsolidation`, `reflect.js`'s `POST /` handler, and `query-expander.js`'s `analyzeQuery`. VS Code / ts-check pick these up and give you the IntelliSense benefit without the migration cost.

If the project ever grows a second external consumer beyond the MCP server, revisit. Right now it's YAGNI.
