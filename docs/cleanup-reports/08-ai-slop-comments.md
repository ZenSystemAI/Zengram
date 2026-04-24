# 08 — AI Slop + Unhelpful Comments

## Summary

Rough counts across `api/src` and `mcp-server/src` (37 JS files, ~6.5k LOC):

- **Narration comments** ("Store X", "Build Y", "Extract entities"): ~30–40 instances, concentrated in `routes/memory.js`, `services/consolidation.js`, `routes/briefing.js`, `routes/export.js`.
- **In-motion-work comments** (Qdrant→pgvector journey, v3.0/v2.5.1 markers, "Fix 5/6/7"): ~35 instances, concentrated in `services/pgvector.js`, `routes/memory.js`, `services/entities.js`, `services/temporal-resolver.js`, `services/query-expander.js`.
- **Stubs / LARP / dead helpers**: 4 exported-but-never-imported functions in `services/collection-registry.js` + `services/pgvector.js`. No TODO/FIXME/XXX/HACK markers anywhere (already clean).
- **Leftover console.log**: 0 real leftovers. All ~85 `console.*` calls are tagged structured logging (`[namespace] message…`) — leave as-is.
- **Commented-out code**: 0. Grep for `^\s*//\s*(const|let|return|if|for|await|function)` returned nothing. Clean.
- **Over-doc'd private helpers** (JSDoc on trivially-named internal functions): ~10 instances, mostly in `services/collection-registry.js` and `services/query-expander.js`.

Overall verdict: **moderately over-commented, but not egregious.** The codebase leans toward explanatory comments rather than silent code, which is fine in principle, but two concentrated failure modes need cleaning: (a) the Qdrant→pgvector migration left a bread-crumb trail of "was X, now Y, used to be Z" that describes the journey instead of the current state, and (b) every step of the happy path in `routes/memory.js` and `services/consolidation.js` got a narration label ("Scrub credentials", "Build payload", "Store in Qdrant") that just re-states the next line of code. TODO/FIXME hygiene is genuinely excellent — zero markers, zero commented-out code, zero debug `console.log`.

## Critical assessment

Comment-to-code ratio is around 1:6 by line count — on the high side for a well-named modern JS codebase. Comment *quality* is bimodal: genuinely good "why" comments (race-window explanation in memory.js:540-546, RRF citation in rrf.js:2-3, "60% FP rate" dead-regex gravestone in entities.js) sit next to trivial narrations ("// Scrub credentials" above `scrubCredentials(...)`). The v4 cleanup branch has already nuked the worst noise (per-agent dispatch, graph BFS, unused SDKs), and what remains is mostly the author describing their own in-flight migration (v3.0 → v4, Qdrant → pgvector). Once those become git history they don't belong in the source. A decisive pass can remove ~100 lines of comments across ~10 files and leave the codebase materially more scannable.

## Findings by category

### Narration comments — ~30–40 instances

Representative samples (delete the comment, keep the code):

- `api/src/routes/memory.js:46` — `// Scrub credentials` above `scrubCredentials(content)`.
- `api/src/routes/memory.js:49` — `// Generate content hash for dedup` above `crypto.createHash('sha256')...`.
- `api/src/routes/memory.js:147` — `// Build payload` above literal `const payload = {...}`.
- `api/src/routes/memory.js:192` — `// Extract entities (fast path — regex + alias cache, no LLM)` — first half narrates; the "(fast path…)" parenthetical is the only useful part. Rewrite OR drop.
- `api/src/routes/memory.js:223` — `// Store in Qdrant` above `upsertPoint(...)`. Doubly wrong: narrates AND names the wrong backend.
- `api/src/routes/memory.js:246` — `// Store in structured database (if configured)` above the `if (isStoreAvailable())` block.
- `api/src/routes/memory.js:502` — `// Re-sort by effective_score` above `results.sort(...)`.
- `api/src/routes/memory.js:580` — `// Re-score and return` above the for loop.
- `api/src/routes/memory.js:703` — `// Re-extract entities`.
- `api/src/routes/memory.js:716` — `// Re-embed and upsert full point (vector + merged payload)`.
- `api/src/routes/memory.js:721` — `// Re-index in keyword search`.
- `api/src/routes/memory.js:730` — `// Re-link entities (fire-and-forget)`.
- `api/src/services/consolidation.js:91` — `// Pull ALL unconsolidated memories (paginated)`.
- `api/src/services/consolidation.js:107` — `// Group by client_id for focused analysis`.
- `api/src/services/consolidation.js:124` — `// Process in batches of 50 to stay within context limits`. (The "to stay within context limits" half is a real why — keep that half, drop the narration.)
- `api/src/services/consolidation.js:137` — `// Mark batch as consolidated`.
- `api/src/services/consolidation.js:230` — `// Validate top-level structure`.
- `api/src/services/consolidation.js:236` — `// Validate: strip any memory IDs not in the current batch` — narration is redundant; the real signal is "strip IDs not in batch" which is what the code literally does.
- `api/src/services/consolidation.js:280` — `// Store merged facts as new memories (with dedup)`.
- `api/src/services/consolidation.js:322` — `// Index in keyword search (so merged facts appear in BM25 results)` — the parenthetical is useful, the lead is narration.
- `api/src/services/consolidation.js:331` — `// Write to structured DB (so merged facts appear in /memory/query)` — same split: keep parenthetical, drop narration.
- `api/src/services/consolidation.js:366` — `// Store contradictions as decision-type memories (need human/agent review)`.
- `api/src/services/consolidation.js:413` — `// Update connection metadata on existing points`.
- `api/src/services/consolidation.js:430` — `// Store compressed summaries as new fact-type memories (without superseding source memories)` — borderline; the "(without superseding)" half carries real information because the next block looks almost identical to the merging block above it. Keep that half.
- `api/src/services/consolidation.js:520` — `// Find the point in the batch to check current knowledge_category` above `const point = points.find(p => p.id === kc.memory_id)`.
- `api/src/routes/briefing.js:25` — `// Get recent events from Qdrant (paginated scroll)`.
- `api/src/routes/briefing.js:61` — `// Build summary (always included)`.
- `api/src/routes/briefing.js:77` — `// Build entry based on format`.
- `api/src/routes/briefing.js:136` — `// Build response based on format`.
- `api/src/routes/export.js:23` — `// Build Qdrant scroll filter`.
- `api/src/routes/export.js:108` — `// Process in batches of 10 with 100ms delay between batches`.
- `api/src/routes/export.js:117` — `// Process each record in the batch sequentially`.
- `api/src/routes/export.js:139` — `// Scrub credentials (same as POST /memory)`.
- `api/src/routes/export.js:142` — `// Compute content hash from scrubbed content`.
- `api/src/routes/export.js:145` — `// Check for existing memory with same content hash, scoped by tenant + type`.
- `api/src/routes/export.js:156` — `// Embed and generate ID`.
- `api/src/routes/export.js:161` — `// Build full payload`.
- `api/src/routes/export.js:209` — `// Write to structured store (matching memory.js patterns)`.
- `api/src/routes/entities.js:287` — `// Create alias from secondary name`.
- `api/src/routes/entities.js:293` — `// Update mention count on primary`.
- `api/src/routes/entities.js:299` — `// Delete secondary (CASCADE removes remaining links/aliases)` — borderline; the "CASCADE removes" half is real information. Keep parenthetical.
- `api/src/services/pgvector.js:258` — `// Return the keyset for the next page`.
- `api/src/services/pgvector.js:295` — `// Build SET clause: always merge JSONB, plus rewrite any promoted columns that appear in the update.` (The "plus rewrite any promoted columns" is real — the function does two things at once. Keep that half.)
- `api/src/services/pgvector.js:392` — `// Find all memories whose payload.entities contains {name: entityName, type: oldType}` — narrates a line of SQL that says the same thing.
- `api/src/index.js:25` — `// Validate required environment variables`.
- `api/src/index.js:71` — `// Initialize structured storage backend`.
- `api/src/index.js:74` — `// Initialize keyword search (BM25 via Postgres tsvector or SQLite FTS5)` — the parenthetical is informative, the lead narrates.
- `api/src/services/stores/postgres.js:13` — `// Create tables` above a `CREATE TABLE` statement.
- `api/src/services/stores/postgres.js:120` — `// Keyword search table (BM25 via tsvector)` — borderline, parenthetical is useful.
- `api/src/services/stores/postgres.js:138` — `// tsvector auto-compute trigger`.

Rule of thumb for this bulk: if the comment is a verb matching the next line's function name, delete it. If the comment has a parenthetical explaining *why* this step exists or how it differs from an adjacent identical-looking block, keep only the parenthetical.

### In-motion-work comments — ~35 instances

These describe the journey from Qdrant→pgvector and v3.x→v4, not the current state. They belong in `CHANGELOG.md`:

- `api/src/services/pgvector.js:1-10` — entire file-top block explains what v4 replaced. The file exists and works; readers don't need the story. Replace with a one-line header describing what the file does today.
- `api/src/services/pgvector.js:17` — `// Memory decay config (same as qdrant.js had)`.
- `api/src/services/pgvector.js:85` — `// Extension not yet installed — will be created by initPgvector` (ok as-is — borderline control-flow comment).
- `api/src/services/pgvector.js:100-103` — `export async function initQdrant()` with comment `// Shim for backward-compat with imports from index.js. Calls initPgvector.` — but `index.js` only imports `initPgvector`, not `initQdrant`. The shim has no consumer. **Dead code.** Delete the function and its comment.
- `api/src/services/pgvector.js:198-200` — `// Cosine similarity: pgvector '<=>' is cosine distance (0 = identical, 2 = opposite). / We want a similarity score in [0,1] range matching Qdrant's behavior, so: 1 - (distance / 2). / Score threshold 0.3 matches the old Qdrant search_points score_threshold.` — First sentence is good (explains the `<=>` operator). Last sentence is in-motion-work ("matches the old Qdrant…"). Keep line 1, drop the Qdrant-comparison lines.
- `api/src/services/pgvector.js:239-240` — `// than Qdrant's opaque token, and stable across writes since (created_at, id)…` — keep the "stable across writes" half, drop the Qdrant comparison.
- `api/src/services/pgvector.js:347` — `// --- Effective confidence (pure function, unchanged from qdrant.js) ---` → `// --- Effective confidence (pure function) ---`.
- `api/src/services/pgvector.js:417-431` — exported `createQdrantCollection` / `deleteQdrantCollection` / `listQdrantCollections` with "compat shim" comments. Consumers in `routes/collections.js` also still use the `Qdrant*` names. Either rename all three (+ callers) to `create/delete/listCollection`, or leave the names and nuke the "compat shim" commentary. Recommend rename.
- `api/src/services/collection-registry.js:1` — `// Collection registry — manages multiple Qdrant collections.` → `// Collection registry — manages multiple collections.`
- `api/src/services/collection-registry.js:15, 81` — JSDoc lines say "Qdrant collection". Scrub.
- `api/src/services/collection-registry.js:98-116` — `getCollectionIndexes()` returns a Qdrant-style `field_schema: 'Keyword'` payload-index spec. pgvector doesn't use this. **Dead code**. Delete the function.
- `api/src/services/collection-registry.js:83-93` — `getCollectionConfig()` returns a Qdrant-style `{ vectors: { size, distance }, optimizers_config }`. Never imported. **Dead code**. Delete.
- `api/src/services/consolidation.js:14` — `// Consolidation run history (in-memory, persisted via Qdrant events)` — pgvector is the vector store now, not Qdrant. Reword or drop.
- `api/src/services/relevance-scorer.js:36` — JSDoc: `Called after entity extraction and embedding, before Qdrant upsert.` → `… before vector upsert.`
- `api/src/services/relevance-scorer.js:111` — `// Non-blocking — skip near-duplicate check if Qdrant is slow`.
- `api/src/services/relevance-scorer.js:137` — JSDoc: `Returns object to spread into the Qdrant payload.` → `… into the vector payload.`
- `api/src/services/stores/baserow.js:112` — `// Entity methods — no-ops for Baserow (entity data comes from Qdrant payload only)`.
- `api/src/services/stores/interface.js:29` — `console.log('[store] Running without structured storage (Qdrant only)')`.
- `api/src/services/stores/interface.js:128` — `// Direct store access (used by graph visualization, keyword search init)` — graph visualization was removed in v4. Drop that clause.
- `api/src/routes/briefing.js:25` — `// Get recent events from Qdrant (paginated scroll)`.
- `api/src/routes/collections.js:13-30` — "Qdrant" mentioned throughout. The response field `exists_in_qdrant` is part of a public API, so be careful; the comments can be scrubbed without changing the response shape.
- `api/src/routes/export.js:23, 185, 236` — `// Build Qdrant scroll filter`, `// Upsert to Qdrant`, `// Qdrant succeeded, structured store failed`.
- `api/src/routes/entities.js:117, 118, 120, 122, 130, 131, 146` — Qdrant mentioned in comments AND in response field names (`qdrant_updated`, `qdrant_scanned`). If you want to keep a stable response contract, leave the field names; if this is internal, rename.
- `api/src/routes/memory.js:68, 82, 101, 286` — response objects include `stored_in: { qdrant: true, structured_db: true }`. This is public API shape. If consumers rely on `qdrant: true`, leave it. If not, rename to `vector: true`. Flag for decision, don't silently change.
- `api/src/routes/memory.js:23-25` — `// Canonical agent identity — all writes attributed to "claude-code" regardless / of which Claude variant or machine. Retired: ti-claude, mini-claude, morpheus, / neo, autolab, n8n (stray writes from these are accepted but coerced).` — the "Retired: …" list is a migration note. The *current* invariant ("all writes attributed to claude-code") is the part worth keeping. Trim to one line.
- `api/src/routes/memory.js:41` — `// Coerce all writes to canonical identity — per-agent identity was retired.` → `// Coerce all writes to canonical identity.`
- `api/src/routes/memory.js:120, 133` — `// Find existing active fact with same key (targeted Qdrant query)`, `// Find existing active status with same subject (targeted Qdrant query)`.
- `api/src/routes/memory.js:177` — `// v3.0: Compress-at-ingestion for events (session logs are verbose, compress for retrieval)`. Drop the `v3.0:` prefix — keep the rest; it's actually a useful why.
- `api/src/routes/memory.js:299` — `// Paths: vector (semantic) + keyword (BM25). Graph BFS path retired in v4.` → `// Paths: vector (semantic) + keyword (BM25).`
- `api/src/routes/memory.js:330` — `// Entity filter — resolve alias to canonical name, then filter via Qdrant payload`.
- `api/src/routes/memory.js:360` — `// entity filter is Qdrant-only` — inline comment.
- `api/src/routes/memory.js:452, 456` — `// v3.0: Importance weighting …`, `// v3.0: Index format …`. Drop the `v3.0:` prefix; the content after the colon is fine.
- `api/src/routes/memory.js:312, 319, 349, 448, 505, 571` — `// --- Fix 5/6/7: …` and `// Fix 6: …`. These are the PR-number leakage. Replace with what the code does, not when it was added. E.g. line 312 `// --- Query expansion / domain inference ---`.
- `api/src/middleware/auth.js:3-4` — `// v4: single admin key. Per-agent identity was retired — all writes / attribute to "claude-code" via the memory route handler.` → `// Single admin key. All writes attributed to "claude-code" in the memory route handler.`
- `api/src/services/entities.js:2-3` — `// v3.0 — Confidence-gated extraction. Removed CAPITALIZED_PHRASE_REGEX (60% FP rate). / Quoted names only match alias cache. Entity staging via confidence field.` — the `v3.0 —` prefix is in-motion. The rest is a decent "why" that justifies the lack of a regex. Trim prefix only.
- `api/src/services/entities.js:42` — `// REMOVED: CAPITALIZED_PHRASE_REGEX — 60% false positive rate, primary source of entity drift` — this is a gravestone explaining why a thing *isn't* there. I'd **keep it** — prevents re-introduction. (Same reasoning for lines 183–191 which are the detailed gravestone.) Borderline on stale-vs-useful; I lean keep.
- `api/src/services/entities.js:171` — `// v3.0: No longer creates new entities from unknown quoted text (was primary junk source)` → `// Don't create new entities from unknown quoted text (was primary junk source)`.
- `api/src/services/query-expander.js:5-6` — `// v2.5.1 — Added preference keyword boost and multi-query reformulation for / preference-style queries (benchmark showed 10% on preferences with v2.4).` Delete both lines.
- `api/src/services/temporal-resolver.js:4-6` — `// v2.5.1 — Added "yesterday", "today", "this week/month/year", "recently" patterns. / Added ordering direction for first/earliest/latest queries. / Tightened "last month/year" ranges (were too wide).` Delete all three.

### Stubs / LARP — 4 items

Each of these is exported but never imported anywhere in `api/src` or `mcp-server/src`. Dead code pretending to be public API.

1. **`api/src/services/pgvector.js:100` — `export async function initQdrant()`**. Documented as a "backward-compat shim" for imports from `index.js`, but `index.js:13,67` imports `initPgvector` directly. No callers. Delete.
2. **`api/src/services/collection-registry.js:83` — `export function getCollectionConfig()`**. Returns `{ vectors: { size, distance: 'Cosine' }, optimizers_config: { indexing_threshold: 100 } }` — a Qdrant `/collections` create-request body. pgvector doesn't consume this config shape. Zero callers. Delete.
3. **`api/src/services/collection-registry.js:98` — `export function getCollectionIndexes()`**. Returns the Qdrant payload-index spec (`field_schema: 'Keyword'`). Zero callers (pgvector creates btree/HNSW indexes directly in `initPgvector`). Delete.
4. **`api/src/services/collection-registry.js:69` — `export function isKnownCollection()`**. Zero callers. Delete or wire up.

Also flag for triage (not stubs, but exports with no visible consumers in the same grep):

- **`api/src/services/query-expander.js:176` — `export function getPreferenceKeywords()`**. Only `extractTopic` and `generateSubQueries` (also unused) call it. Never imported by `routes/memory.js`. Either wire up or delete.
- **`api/src/services/query-expander.js:196` — `export function generateSubQueries()`**. Same story — unused.
- **`api/src/services/relevance-scorer.js:24` — `export function updateSourceTrust()`**. File comment at line 21 says it's "Refreshed periodically via feedback loop" — but `services/feedback-loop.js` was deleted in v4. The only callers of this trust cache would have been the deleted feedback loop. `getSourceTrust()` is still called (line 85), so the cache isn't entirely dead — it just never gets populated. Either wire up a replacement populator or delete `updateSourceTrust` and inline a constant 0.5 in `getSourceTrust`.

### Leftover console.log — 0

All `console.log`/`console.error`/`console.warn`/`console.debug` calls are tagged structured logging (e.g. `[zengram]`, `[memory:store]`, `[consolidation]`, `[entities:reclassify]`). None are naked debug prints. Do not touch.

### Commented-out code — 0

Grepped for `^\s*//\s*(const|let|var|await|return|if|for|function|import|export|})` — zero matches. Clean.

### Over-doc'd private helpers — ~10 instances

JSDoc on trivially-named or single-purpose internal functions whose signature is already self-documenting:

- `api/src/services/collection-registry.js:14-17` — JSDoc on `resolveCollection()`. Body is 6 lines of string manipulation.
- `api/src/services/collection-registry.js:29-31` — JSDoc on `getDefaultCollection()` — one-liner that returns a constant.
- `api/src/services/collection-registry.js:36-38` — JSDoc on `validateCollectionSlug()`.
- `api/src/services/collection-registry.js:49-51` — JSDoc on `registerCollection()`.
- `api/src/services/collection-registry.js:56-58` — JSDoc on `listCollections()`.
- `api/src/services/collection-registry.js:66-68` — JSDoc on `isKnownCollection()`.
- `api/src/services/collection-registry.js:73-75` — JSDoc on `unregisterCollection()`.
- `api/src/services/keyword-search.js:23-26` — JSDoc on `indexMemory()`. Includes `Fire-and-forget — failures are logged but don't block the write path.` which is a genuine invariant. Keep that line, drop the rest.
- `api/src/services/keyword-search.js:52-54` — JSDoc on `deactivateMemory()`. One line that repeats the function name.
- `api/src/services/keyword-search.js:157-159` — JSDoc on `getKeywordIndexCount()`. One line.
- `api/src/services/entities.js:195-197` — JSDoc on `reclassifyEntity()`. One line that restates the signature.

Keep the JSDoc on genuine public/contract surfaces (I recommend keeping):

- `api/src/services/rrf.js:7-19` — full JSDoc on `reciprocalRankFusion` including the formula, citation, and semantics of `k`. This is load-bearing documentation for a pure algorithm with a published reference. Keep as-is.
- `api/src/services/fetch-with-timeout.js:1-7` — JSDoc on the default export. Keep — it's the only export and documents timeout semantics.
- `api/src/services/relevance-scorer.js:34-47` — JSDoc on `scoreRelevance` (the public scoring function consumed by routes). Keep the `@param` table — function takes a 7-field object and the types matter. Drop the "before Qdrant upsert" line (in-motion-work).
- `api/src/services/query-expander.js:69-73, 113-117, 125-128, 146-149, 167-175, 187-195` — JSDoc on `analyzeQuery`, `expandQuery`, `extractSearchTerms`, `extractTopic`, `getPreferenceKeywords`, `generateSubQueries`. Borderline — some are genuinely useful because the query-shape isn't obvious, others just restate names. `analyzeQuery`'s `@returns` schema is useful. `expandQuery` is a one-liner that doesn't need it. Selectively trim.
- `api/src/services/temporal-resolver.js:8-13, 188-195` — JSDoc on `resolveTemporalQuery` (returns a 5-field object — the schema doc is useful) and `temporalProximityBoost` (mathematical function). Keep both.

## Bulk-delete recommendation

To keep this a manageable pass (not 200 nitpicks), do three focused commits:

**Commit 1 — "remove Qdrant migration residue"** (largest impact, clearest rationale):
1. Grep-replace in comments/JSDoc only: `"Qdrant"` → `"vector store"` or drop the phrase entirely. Do NOT auto-rename function/response-field names — those are API contracts.
2. Rewrite the file header of `api/src/services/pgvector.js` to describe what it does now, not what it replaces.
3. Delete three dead functions: `pgvector.js:initQdrant`, `collection-registry.js:getCollectionConfig`, `collection-registry.js:getCollectionIndexes`, `collection-registry.js:isKnownCollection`.
4. Drop "Retired: …" lists in `routes/memory.js:23-25` and `middleware/auth.js:3-4`.
5. Drop "v3.0:", "v2.5.1 —", "Fix 5/6/7:" prefixes throughout. Where the sentence after the prefix is still useful, keep the sentence.

**Commit 2 — "remove narration comments"**:
Batch-delete single-line comments that narrate the next line. Focus files: `routes/memory.js`, `services/consolidation.js`, `routes/briefing.js`, `routes/export.js`, `services/pgvector.js`. Rule: if the comment is a verb phrase matching the following statement's function name or assignment target, delete. If the comment has a parenthetical that explains *why*, keep only the parenthetical (promote it to the full comment).

**Commit 3 — "trim over-doc'd internal helpers"**:
Remove JSDoc blocks from `services/collection-registry.js` (keep one-line `//` comment per function if the name isn't obvious) and from trivial functions in `services/keyword-search.js`, `services/entities.js`, `services/query-expander.js`. Preserve JSDoc where the `@returns` schema is load-bearing (analyzeQuery, resolveTemporalQuery, scoreRelevance, reciprocalRankFusion).

Expected line-count delta: **~120–150 lines of comments removed, ~20–40 lines of dead code (the 4 unused functions) removed, net.** No behavioral changes.

## Keeps (comments that MUST stay)

Do not let the cleanup agent touch these — they document genuine "why" or hidden contracts:

- **`api/src/services/rrf.js:2-3`** — citation to the RRF paper (Cormack/Clarke/Buettcher 2009) and attribution to vectorize-io/hindsight. Actionable link, load-bearing reference.
- **`api/src/services/rrf.js:7-19`** — JSDoc on `reciprocalRankFusion`. Documents the formula, the smoothing constant `k`, and the "items in multiple lists get boosted, items missing don't get penalized" invariant that callers need to reason about.
- **`api/src/routes/memory.js:540-546`** — the race-window comment on `access_count` updates ("We fetch current point payloads in a single batch call before writing to reduce the race window… A tiny race still exists between the getPoints read and the updatePointPayload write, but it is acceptable for a fire-and-forget decay-prevention counter."). This is exactly the kind of "why" that saves future debuggers hours.
- **`api/src/routes/memory.js:113-115`** — `// Facts without keys can't be superseded — they pile up forever. / Log a warning so we can track and fix callers over time.` Explains an intentional data-hygiene invariant.
- **`api/src/services/entities.js:42`** and **`api/src/services/entities.js:183-191`** — the `CAPITALIZED_PHRASE_REGEX` gravestone. Explains why a regex you'd instinctively add is missing ("60% false positive rate, primary source of entity drift"). Prevents re-introduction. Borderline in-motion, but the "prevents re-introduction" value is high.
- **`api/src/services/llm/gemini.js:27-28`** — `// Gemini 2.5 Flash thinking tokens count against maxOutputTokens. / Cap thinking to preserve budget for the actual JSON response.` Vendor-specific gotcha, not re-derivable from the code.
- **`api/src/services/llm/gemini.js:42`** — `// Check for truncation — Gemini returns MAX_TOKENS when thinking + output exceeds budget` and the adjacent thinking-parts comment. Same vendor-quirk category.
- **`api/src/services/consolidation.js:198`** — `// Format memories for the LLM — wrapped in XML tags to resist prompt injection`. Security invariant; non-obvious.
- **`api/src/services/consolidation.js:220`** — `// Strip markdown code fences the LLM may wrap around the JSON`. Workaround for a known LLM quirk.
- **`api/src/services/pgvector.js:29-30`** — `// Register the pgvector type as array-of-float so values round-trip cleanly. / Without this, pg returns the raw '[1,2,3]' string and upserts fail on type mismatch.` Library-interaction gotcha with specific failure mode.
- **`api/src/services/pgvector.js:58-59`** — `// Indexes — HNSW for vector ANN, btree for hot-path filters, GIN for JSONB entity filter. / HNSW creation is idempotent via IF NOT EXISTS but takes a moment on first create.` Performance note that's load-bearing for operators.
- **`api/src/services/pgvector.js:198`** — `// Cosine similarity: pgvector '<=>' is cosine distance (0 = identical, 2 = opposite).` (Drop the two lines after it that compare to Qdrant, but keep this line — the `<=>` operator semantics aren't obvious at a glance.)
- **`api/src/services/pgvector.js:237-240`** — the keyset-offset explanation (`Offset here is a keyset token: the created_at + id of the last row… stable across writes since (created_at, id) is unique enough in practice`). Documents a design choice and its trade-off. Drop only the "than Qdrant's opaque token" clause.
- **`api/src/services/keyword-search.js:124-126`** — `// FTS5 MATCH query — strip special characters and reserved words / const FTS5_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR']);`. Explains the sanitization.
- **`api/src/services/stores/postgres.js:66`** — `// Migrate: add knowledge_category to existing tables (safe if already exists)`. Explains an online-migration pattern.
- **`api/src/services/stores/sqlite.js:64`** (inside `deactivateMemory` in keyword-search.js also) — `// FTS5 doesn't support active flag — delete the row`. Backend difference that's load-bearing.
- **`api/src/routes/memory.js:360`** — the `// entity filter is Qdrant-only` inline needs rewording (not deleting) to `// entity filter is vector-store-only` — the invariant is real (keyword-search can't do nested entity filters), the wording just got stale.
- **The "fire-and-forget" comments throughout memory.js / consolidation.js** (e.g. memory.js:232, 235, 567; consolidation.js:328, 345, 398) — these announce that a `.catch()` handler is intentional and errors are non-blocking. Keep. They prevent well-meaning reviewers from "fixing" async-error-handling that isn't broken.

Err toward keeping. Anything that describes vendor quirks, race windows, security invariants, performance trade-offs, or why-a-thing-is-missing-on-purpose should stay.
