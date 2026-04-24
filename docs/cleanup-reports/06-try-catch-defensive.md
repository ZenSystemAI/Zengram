# 06 — Defensive try/catch + Error Hiding

Scope: `api/src/**/*.js` + `mcp-server/src/**/*.js` on `cleanup/8-pass-refactor @ 556642c`.

## Summary

- **76 `try` blocks** across 18 files (37 JS files total).
- **~23 `.catch(...)` tail-handlers** on promise chains (a large chunk of the error-hiding footprint lives here, not in `try/catch`).
- Rough split: **~22 legitimate** (top-of-handler 500-converters, untrusted JSON parse, transaction cleanup, best-effort side-effects), **~30 defensible but noisy** (fire-and-forget side-channels — keyword index, entity linking, audit logs), **~24 defensive / bug-hiding** (the findings below).
- **Ratio of truly defensive to legitimate ≈ 1 : 2.2.** Not pathological, but the "ignore the error and hope it works" pattern is systematic around the LLM→JSON parse path, around entity-link failures, and around every `deactivateMemory().catch(() => {})` call.

## Critical assessment

**Does this codebase have an error-hiding problem?** — Yes, localized but real.

Three patterns dominate and each one would mask a real bug in production:

1. **Silent `.catch(() => {})` on keyword-index / entity-link writes.** If Postgres starts rejecting these inserts (schema drift, FK violations, lock contention) the API returns 201 Created every time and the BM25 index silently stops catching up. Search quality rots before anyone sees a stack trace. Evidence: `api/src/routes/memory.js:130`, `:143`, `:788`, `api/src/routes/entities.js:280`, `:285`.
2. **LLM→JSON parse errors swallowed inside consolidation.** `consolidation.js:225` returns `{ merged: 0, ... }` on `JSON.parse` failure. If the LLM consistently returns malformed JSON (e.g., a provider change, a prompt regression), consolidation looks healthy in the logs but processes zero work. The batch is still marked `consolidated: true` at `consolidation.js:139`, so the bad batch never retries.
3. **"Point might not exist" comments as justification for empty catch blocks.** `consolidation.js:357-359`, `:422-424`, `:504-507`, `:528-530` all assume the source memory could have been deleted mid-consolidation. In practice, `scrollPoints` returns the batch and nothing else deletes from Qdrant during the run — these catches would more likely hide real `updatePointPayload` failures (bad payload shape, network blip) than missing points.

**Are there bugs that would surface if we removed defensive wraps?** — Almost certainly yes:
- The `catch(() => {})` at `memory.js:788` on `deactivateMemory` is a soft-delete path. If keyword search were misconfigured, deleted memories would still come back in BM25 results, and the only signal would be a production search returning "why is this deleted memory still here?".
- The `entity-reclassify` Qdrant update at `entities.js:119-123` swallows any batch update failure and keeps going. If the update fails for 40 memories of 50, the route still returns success with correct counts — no tripwire.

**Does not have a problem with:** top-level Express handlers (the outer `try/catch` → 500 pattern is consistent), JSON-body validation (already converts to 400), or the fetch-timeout wrapper (narrow, purposeful).

---

## Findings (ordered by confidence)

### HIGH — `deactivateMemory().catch(() => {})` swallows all errors silently
**Files:** `api/src/routes/memory.js:130`, `:143`, `:788`
```js
deactivateMemory(matches[0].id).catch(() => {});
// ...
deactivateMemory(id).catch(() => {});
```
**Why it's defensive:** Nothing logs, nothing retries, nothing degrades gracefully. `deactivateMemory` is a Postgres UPDATE in the `memory_search` table (keyword-search.js). Realistic failure modes: connection pool exhaustion, prepared-statement prep error, schema drift. All of these are real bugs that should be loud.
**Proposed change:** Replace with logging-only catch, consistent with the neighbouring `indexMemory(...).catch(e => console.error('[memory:keyword-index]', e.message))` at `memory.js:232`. Five seconds of work, zero risk.
**Risk being absorbed:** Keyword index silently drifts — deleted/superseded memories keep surfacing in BM25 results because the `active=false` flag never propagates.

---

### HIGH — Entity merge `.catch(() => {})` on UPDATE queries
**Files:** `api/src/routes/entities.js:280`, `:285`
```js
await store.pool.query(`UPDATE entity_relationships SET source_entity_id = $1 ...`)
  .catch(() => {});
await store.pool.query(`UPDATE entity_relationships SET target_entity_id = $1 ...`)
  .catch(() => {});
```
**Why it's defensive:** The comment just above says "Move relationships from secondary to primary". If the UPDATE fails (unique-constraint violation on `(source,target,type)`, which is a real constraint per `postgres.js:106`), the merge reports success while half the relationships are still pointing at the now-deleted `secondary` entity. Shortly after, `DELETE FROM entities WHERE id = secondary.id` (`entities.js:300`) CASCADEs and drops those orphans — but the "success" response already claimed the merge moved them.
**Proposed change:** Narrow the catch to unique-constraint violations only (`if (e.code !== '23505') throw e;`). Keep a warn log even for the constraint case. Let anything else propagate to the route's outer catch → 500.
**Risk being absorbed:** Broken merges reported as successful; eventually orphan `entity_relationships` that CASCADE-disappear with no trace.

---

### HIGH — Consolidation "point might not exist" catches that aren't actually checking that
**Files:** `api/src/services/consolidation.js:357-359`, `:422-424`, `:504-507`, `:528-530`
```js
try {
  await updatePointPayload(sourceId, { active: false, superseded_by: mergedId, ... });
} catch (e) {
  // Source memory might not exist — skip
}
```
**Why it's defensive:** The comment claims the source memory might be gone, but (a) `updatePointPayload` on pgvector is `UPDATE memories SET ... WHERE id = $1` which simply affects zero rows on a missing ID — it doesn't throw. So the catch is only reachable on a *real* failure (bad payload shape, connection, parameter-binding bug). (b) Even if it did throw on a missing row, the LLM suggested this ID one second ago from a batch pulled from the same table — it's still there.
**Proposed change:** Remove all four `try/catch` blocks; let `updatePointPayload` errors propagate up to the `consolidateBatch` caller (already wrapped at `consolidation.js:140-143`). One guard, loud on real failure.
**Risk being absorbed:** Consolidation appears to merge N facts but actually updated zero supersedes chains; old memories stay active alongside new merged fact — causes duplicate results in search.

---

### HIGH — LLM-response JSON parse swallows then returns zeros
**File:** `api/src/services/consolidation.js:219-228`
```js
try {
  let jsonText = responseText.trim();
  const fenceMatch = jsonText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();
  result = JSON.parse(jsonText);
} catch (e) {
  console.error('[consolidation] LLM returned invalid JSON:', responseText.slice(0, 300));
  return { merged: 0, contradictions: 0, connections: 0, compressed_summaries: 0 };
}
```
**Why it's legitimate-ish but problematic:** Parsing untrusted (LLM) JSON — catching `SyntaxError` is correct. The problem is what happens *after*: the caller (`runConsolidation` at line 140) does `await updatePointPayload(ids, { consolidated: true, ... })` unconditionally on the batch. So a batch that produced garbage JSON gets marked consolidated and never retries.
**Proposed change:** Keep the catch, but *throw* a tagged error (`throw new LlmJsonError(...)`) so the outer `runConsolidation` loop can skip the `consolidated: true` write for that batch. Two lines of code, prevents permanent data loss on provider flakes.
**Risk being absorbed:** Consolidation silently drops an entire 50-memory batch when the LLM has a bad day.

---

### MEDIUM — Entity co-occurrence relationship creation — empty catch
**File:** `api/src/services/entities.js:273-276`
```js
for (let i = 0; i < uniqueIds.length; i++) {
  for (let j = i + 1; j < uniqueIds.length; j++) {
    try {
      await createRelationship(uniqueIds[i], uniqueIds[j], 'co_occurrence');
    } catch (e) {}
  }
}
```
**Why it's defensive:** Completely empty catch. The real expected error here is the unique constraint on `(source, target, type)` — every co-occurrence after the first is a duplicate. But the catch also swallows FK violations, connection errors, and programming bugs.
**Proposed change:** Narrow to the specific Postgres error code: `catch (e) { if (e.code !== '23505') console.warn('[entities:cooccurrence]', e.message); }`. Alternatively, push the `ON CONFLICT DO NOTHING` into the SQL itself and remove the catch.
**Risk being absorbed:** Entity graph silently stops building relationships if anything else breaks.

---

### MEDIUM — Search-retry double-catch on zero results
**File:** `api/src/routes/memory.js:576-596`
```js
if (broader && broader.length > 3) {
  try {
    const retryVector = await embed(broader, 'search');
    const retryResults = await searchPoints(retryVector, filter, maxResults, ...);
    if (retryResults.length > 0) { ... return res.json({...}); }
  } catch (e) { /* retry failed, return empty */ }
}
```
**Why it's defensive:** Catches any error from the retry path and silently returns an empty response. The outer handler (line 620) already does the same 500-conversion. If `embed()` or `searchPoints()` fail on the retry, the user gets `count: 0, results: []` and no signal that anything broke — indistinguishable from "no matches."
**Proposed change:** Remove the inner catch entirely. Let retry errors propagate — they're the same class of errors as the primary-path errors, and they should behave the same way (500 with request_id).
**Risk being absorbed:** Embedder outages during retry path mask as "no results found."

---

### MEDIUM — `getCollectionInfo` used as existence probe
**File:** `api/src/routes/collections.js:52-58`
```js
try {
  await getCollectionInfo(name);
  return res.status(409).json({ error: `Collection '${collectionName}' already exists` });
} catch (e) {
  if (!e.message?.includes('404')) throw e;
  // 404 = doesn't exist, good to create
}
```
**Why it's defensive-ish:** This is the control-flow-via-exception pattern, using stringified error messages (`.includes('404')`) instead of a typed check. Pgvector / Qdrant error shapes can change between versions and this match is brittle.
**Proposed change:** Add an explicit `collectionExists(name)` helper to `pgvector.js` that returns a boolean. Remove the try/catch entirely.
**Risk being absorbed:** A future Qdrant/pgvector client update that changes the error message (not the status code) would flip this from "good to create" into an unhandled 500 rethrow.

---

### MEDIUM — Entity-filter name resolution — silent fallback to original name
**File:** `api/src/routes/memory.js:334-339`
```js
if (isEntityStoreAvailable()) {
  try {
    const found = await findEntity(entity);
    if (found) entityName = found.canonical_name;
  } catch (e) { /* use original name */ }
}
```
**Why it's defensive:** If Postgres is unavailable, the entity alias → canonical-name resolution silently fails back to the user's raw input. This looks sensible, but `isEntityStoreAvailable()` was *just checked above* — so the only reasons findEntity would throw are real bugs (connection dropped, schema drift, bad params).
**Proposed change:** Remove the try/catch; let `findEntity` failures bubble. If DB availability is flaky, the `isEntityStoreAvailable()` health check should catch it.
**Risk being absorbed:** Search results silently wrong when alias resolution dies.

---

### MEDIUM — Stats route "non-critical" silencing
**File:** `api/src/routes/stats.js:15-40`
```js
try { ... decayedCount = ... } catch (e) { /* Non-critical */ }
try { entityStats = await getEntityStats(); } catch (e) { /* non-critical */ }
try { keywordIndexCount = await getKeywordIndexCount(); } catch (e) { /* non-critical */ }
```
**Why it's semi-defensive:** Stats is a health-dashboard endpoint, so "best-effort, render what you can" is a defensible policy. But the three silent catches mean the dashboard can show `decayed_below_50pct: 0` while Qdrant is down; the operator looks at the dashboard and thinks all is well.
**Proposed change:** Log the caught error (`console.warn('[stats:decayed]', e.message)`) so there's a server-side tripwire. The response payload can stay the same.
**Risk being absorbed:** Silent failure of the thing that's supposed to tell you things are failing.

---

### LOW — Graceful shutdown store.close best-effort
**File:** `api/src/index.js:129-132`
```js
try {
  const store = _getStoreInstance();
  await store?.close?.();
} catch (e) { /* best-effort */ }
```
**Legitimate (KEEP).** This is the only reasonable thing to do during shutdown — errors on close can't be acted on and the process is exiting anyway. Mention it for completeness; no change needed.

---

### LOW — Alias cache "first run" case
**File:** `api/src/index.js:79-84`
```js
try {
  const aliases = await loadAllAliases();
  loadAliasCache(aliases);
} catch (e) {
  console.log('[zengram] Entity alias cache: starting empty (first run)');
}
```
**Why it's slightly wrong:** Catches all errors but reports only "first run" — same message for an empty table (not an error, wouldn't throw anyway) and for a connection failure.
**Proposed change:** If `loadAllAliases` returning `[]` is the "first run" case, no catch needed. The catch should log the real error: `console.warn('[zengram] Alias cache load failed:', e.message)`.
**Risk being absorbed:** DB-layer bugs masked as "first run" at boot time forever.

---

### LOW — Column-exists-migration swallow
**File:** `api/src/services/stores/postgres.js:68-70`
```js
try {
  await this.pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS knowledge_category ...`);
} catch (_) { /* column already exists */ }
```
**Legitimate but stale.** `ADD COLUMN IF NOT EXISTS` is idempotent in Postgres — this catch is unreachable in practice. Remove the wrapper, or at minimum narrow to the specific "duplicate column" SQLSTATE.
**Proposed change:** Remove the try/catch (the `IF NOT EXISTS` clause already handles it).

---

### LOW — pgvector OID registration defensive catch
**File:** `api/src/services/pgvector.js:77-87`
```js
try {
  const { rows } = await pool.query("SELECT oid FROM pg_type WHERE typname = 'vector'");
  ...
} catch (e) {
  // Extension not yet installed — will be created by initPgvector
}
```
**Legitimate — narrow and documented.** The extension really may not exist on first boot. KEEP. Could improve by logging when caught (debug level).

---

### LOW — MCP outer-most catch on unknown-tool
**File:** `mcp-server/src/index.js:435`
**Legitimate (KEEP).** This is the tool-dispatch handler — every tool must convert errors into MCP `isError: true` responses, otherwise the MCP client sees a protocol crash. Equivalent to the Express 500-converter pattern.

---

### LOW — `main().catch(console.error)` in MCP entrypoint
**File:** `mcp-server/src/index.js:657`
```js
main().catch(console.error);
```
**Legitimate (KEEP).** This is the process-entrypoint — any unhandled rejection terminates the stdio transport, which is exactly what we want. `console.error` at least writes to stderr (the MCP log channel) rather than `console.log`.

---

## Keeps (legitimate try/catch — briefly)

Categories confirmed during review:
- **Express route top-of-handler `try { ... } catch (err) { 500 }`**: 19 instances across `routes/*.js`. All correct. Consistent `[tag]` logging tag, no silencing. Example: `routes/memory.js:32-295`.
- **Parsing untrusted JSON** (LLM responses, user payloads): `reflect.js:123-131`, `consolidation.js:219-228` (behavioural fix flagged above, but the catch itself is correct). Both legitimately catch `SyntaxError`.
- **Transaction / cleanup semantics**: shutdown close at `index.js:129-132`, timer cleanup in `fetch-with-timeout.js` (uses `finally`, no catch — correct form).
- **Narrow-purpose DB constraint handling**: `sqlite.js:122-128` (CREATE INDEX already-exists guard, narrow error-message match — acceptable given sqlite's lack of structured error codes), `postgres.js:277-279` (alias insert after ON CONFLICT — arguably redundant with ON CONFLICT DO NOTHING, but harmless).
- **Explicit 404-handling via try/catch**: `memory.js:677-682` (getPoint → 404 response). Correct — pgvector `getPoint` throws on missing ID and the handler wants a 404 not a 500.
- **Fire-and-forget side-effect with log-only catch**: `memory.js:232`, `:727`, `consolidation.js:328`, `:345`, `:398`, `:406`, `:477`, `:494`, `export.js:194`, `:204`, `entities.js:152`. These follow a consistent `console.error('[namespace:action]', e.message)` pattern. Defensible for non-critical side-effects like keyword index writes (they'll self-heal on next consolidation reindex).

---

## Subtle error-hiding patterns beyond try/catch

1. **Empty `.catch(() => {})` pattern (5 occurrences):**
   - `memory.js:130`, `:143`, `:788`
   - `entities.js:280`, `:285`
   - **All five are the true-silent category.** Even one `console.error` would turn these from bug-hiders into tripwires.

2. **`.catch(() => [])` — return empty array (2 occurrences):**
   - `reflect.js:57` — `keywordSearch(...).catch(() => [])`. Defensible: BM25 is a best-effort augmentation to vector search; returning [] degrades gracefully to vector-only. But again, no log.
   - Could be `.catch(e => { console.warn(...); return []; })` with zero behaviour change.

3. **Fall-through to fallback values without logging:**
   - `stats.js:22-40` (3 blocks) — dashboard silently renders zeros when upstream fails.
   - `index.js:82-84` — alias cache load failure indistinguishable from empty table.
   - `pgvector.js:84-87` — extension not installed vs. real query failure — indistinguishable.
   - `memory.js:338` — entity alias resolution falls back to raw name with no trace.

4. **Return-zeros-on-parse-failure:**
   - `consolidation.js:227-228` — returns `{ merged: 0, ... }` on JSON parse. Caller marks batch consolidated anyway. Highest-impact error-hider in the codebase.

5. **Stringified error probing:**
   - `collections.js:56`, `:84`, `:108` — `e.message?.includes('404')`. Brittle to client upgrades.

6. **Unhandled-rejection handler at `index.js:21-23`:**
   - `process.on('unhandledRejection', ...)` logs but doesn't exit or alert. Standard Node pattern, but combined with the silent `.catch(() => {})` above, a rejected promise from `deactivateMemory` wouldn't even hit this because the empty catch already consumed it. No path to observability.

---

## Recommendation priority

If doing a single follow-up PR: fix the **five empty `.catch(() => {})` sites** first (lowest risk, highest leverage — converts five silent data-corrosion paths into logged events). Then fix the **consolidation batch-marking bug** (stops a provider flake from burning an entire 50-memory batch). Then revisit the "point might not exist" catches with evidence.
