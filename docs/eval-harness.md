# Retrieval Eval Harness (spike)

> **Status:** SPIKE — design doc + runnable skeleton + smoke fixture only.
> No production constant is tuned by this harness; it *measures*, it does not change behavior.
> Tuning any retrieval knob is a follow-up that *uses* this harness.

## Goal

A small, reproducible, **opt-in** retrieval-quality measurement that:

1. **Backs the README accuracy claim.** `README.md` headlines "98.4% retrieval accuracy on
   LongMemEval," but until now there was no runnable eval in the repo — the number could not be
   reproduced, regression-checked, or used to justify a retrieval change. (`docs/benchmarks.md`
   describes the LongMemEval methodology in prose, but its runner queries pgvector directly and
   bypasses the Express retrieval pipeline.)
2. **Makes every retrieval-constant change measurable.** The retrieval path is governed by a pile of
   magic constants set by intuition (see [Tunable constants](#tunable-constants-the-harness-lets-you-ab)).
   With a harness that seeds a known corpus, runs labeled queries, and reports recall@k / MRR, each
   of those becomes an A/B you can run before/after, instead of a guess with no safety net.

The architecture makes this cheap: the search path is a single HTTP route
(`GET /memory/search`, `api/src/routes/memory.js:269`) and the store is seedable through the
existing import endpoint (`POST /export/import`, `api/src/routes/export.js:91`), which preserves a
caller-supplied `id` (`api/src/routes/export.js:168`) — so fixtures can use stable ids that labeled
queries reference directly.

## Why this is an integration tool, not a unit test

The real pipeline needs a **live API + Postgres (pgvector) + an embedding provider** to run, because
embeddings are network calls. So this harness is an **integration tool run against a disposable local
stack**, not a unit test. It is deliberately:

- kept in its own directory (`api/scripts/eval/`), in the same plain-Node-ESM style as the existing
  operational scripts (`api/scripts/status-staleness.js`, `api/scripts/tier2-compression.js`);
- **never wired into `npm test`** — the suite must stay fast, hermetic, and network-free.

## Metrics

Both metrics are computed per query against that query's `expected_ids`, then averaged over the query
set. `k` defaults to **5 and 10** (reported side by side; a query may override with its own `k`).

- **recall@k** — did *any* expected id appear in the top-k returned results?
  Per query it is `1` if `expected_ids ∩ top_k ≠ ∅`, else `0`. (This is the "hit@k" form: it
  rewards surfacing at least one relevant memory in the window. A stricter "fraction of expected ids
  found in top-k" variant is noted in [Open questions](#open-questions).)
- **MRR@k** (Mean Reciprocal Rank) — `1 / rank` of the **first** expected id within the top-k
  (rank is 1-based), or `0` if no expected id is in the top-k. Averaged over the query set, this
  rewards ranking a relevant memory *higher*, not merely *present*.

Example: top-k ids `[m3, m1, m7, m2, m9]`, expected `[m7]` → recall@5 = 1, reciprocal rank = 1/3.

## Corpus / fixture format

A single JSON file with two arrays:

```jsonc
{
  "memories": [
    {
      "id": "fact-staging-db-port",   // stable id, preserved by POST /export/import
      "type": "fact",                  // event | fact | status | decision
      "key": "staging-db-port",        // facts/statuses supersede by key/subject
      "content": "The staging database runs on port 5544.",
      "importance": "medium"           // critical | high | medium | low (optional)
    }
    // ... 8-12 generic memories total
  ],
  "queries": [
    {
      "q": "what port does the staging database listen on",
      "expected_ids": ["fact-staging-db-port"],
      "k": 5                            // optional per-query override of the default k
    }
    // ... ~5 labeled queries
  ]
}
```

- The `memories` array is **import-shaped** — each object is passed straight to `POST /export/import`
  inside `{ data: [...] }`. Any field that endpoint accepts (`type`, `key`, `subject`, `importance`,
  `client_id`, `knowledge_category`, `category`, `confidence`, `created_at`, …) is allowed; only
  `id` + `content` are strictly required for the harness to work.
- The `queries` array carries the labels. `expected_ids` are the fixture `id`s that *should* rank in
  the top-k for that query. `k` is optional and overrides the harness default per query.
- See `api/scripts/eval/fixtures/smoke.json` for the canonical tiny example.

> **Caveat — import dedup.** `POST /export/import` skips a record whose `content_hash` already exists
> for the same `(client_id, type)` (`api/src/routes/export.js:157`). Re-seeding the same fixture
> against a store that already holds it will report those rows as `skipped` (not an error). For clean
> numbers, seed into an empty/throwaway store — see [Open questions](#open-questions).

## How to run

```bash
# Required: a live API + Postgres + an embedding provider reachable from this host.
export BRAIN_API_URL=http://localhost:8084   # default if unset
export BRAIN_API_KEY=...                       # required; same key the API was started with

cd api
node scripts/eval/run-eval.js                            # uses scripts/eval/fixtures/smoke.json
node scripts/eval/run-eval.js scripts/eval/fixtures/smoke.json   # explicit fixture path
```

Flow:

1. **Seed** — `POST {API}/export/import` with `{ data: fixture.memories }` (header `x-api-key`).
   The endpoint re-embeds each record and preserves the supplied `id`. The harness prints
   `imported / skipped / errors`.
2. **Query** — for each labeled query, `GET {API}/memory/search?q=<encoded>&limit=<k>&format=index`,
   collect the returned `id`s in rank order, and compute hit@k + reciprocal rank vs `expected_ids`.
   (`format=index` returns the minimal `{ id, effective_score, type, summary, … }` shape — all the
   harness needs is `id` in rank order, so the cheapest format is used.)
3. **Report** — a per-query line plus an aggregate line.

Expected output (illustrative — exact numbers depend on the live store and embedding provider):

```
Seeding 10 memories via POST /export/import ...
  imported=10 skipped=0 errors=0

query                                              recall@5  rr@5   recall@10  rr@10
-------------------------------------------------- --------  -----  ---------  -----
what port does the staging database listen on         1     1.000      1      1.000
how often do we deploy                                 1     0.500      1      0.500
...
-------------------------------------------------- --------  -----  ---------  -----
AGGREGATE (n=5)                                    R@5=0.80  MRR@5=0.65   R@10=0.80  MRR@10=0.65
```

If the API is unreachable, the harness prints a one-line "is the API running?" hint (with the URL it
tried) instead of a raw stack trace.

## Extension path (toward LongMemEval)

The smoke fixture is the *shape*, not the *scale*. To grow it toward the
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) methodology framed in `docs/benchmarks.md`:

1. **More cases, same shape.** Author additional fixtures (e.g. `fixtures/temporal.json`,
   `fixtures/knowledge-update.json`) that exercise specific LongMemEval capabilities —
   single-session, multi-session, knowledge-update (a fact superseded by a newer fact), temporal
   reasoning, preference. Same `{ memories, queries }` schema; the runner already accepts a path arg.
2. **Batch the seed.** `POST /export/import` caps at 500 records/request
   (`api/src/routes/export.js:99`). For larger corpora, chunk `memories` into ≤500-record POSTs.
3. **Convert LongMemEval haystacks.** Write a converter that maps LongMemEval sessions →
   import-shaped `memories` and its questions → `queries` with `expected_ids`. (Out of scope for the
   spike; deciding the deterministic-embedding story below is a prerequisite.)
4. **A/B the constants.** Capture an aggregate baseline, change one constant under
   [Tunable constants](#tunable-constants-the-harness-lets-you-ab), re-run, diff. The harness is the
   measurement tool that should precede any such change.

### Tunable constants (the harness lets you A/B)

The retrieval pipeline is governed by these intuition-set constants. None is touched by this spike;
the harness exists so a future change to any of them is a *measured* before/after, not a guess.

| Constant | Location | Current |
|----------|----------|---------|
| `RRF_K` (RRF fusion damping) | `api/src/services/rrf.js:5` | 60 |
| `SEMANTIC_DEDUP_THRESHOLD` (consolidation merge) | `api/src/services/consolidation.js:14` | 0.92 |
| similarity floor + `1 - (distance/2)` cosine rescale | `api/src/services/pgvector.js:194`–`197` | 0.3 floor |
| `IMPORTANCE_WEIGHTS` + access / temporal boost multipliers | `api/src/routes/memory.js:409`–`421` | see code |
| `NEAR_DUPLICATE_THRESHOLD` (relevance scorer) | `api/src/services/relevance-scorer.js:12` | 0.85 |
| HNSW `ef_search` | pgvector index/session (untuned) | deferred (PERF-02) |

## Open questions

These are the spike's primary deliverable — decide them before this graduates from spike to feature.

1. **Deterministic / cheap embeddings for CI.** The harness needs real embeddings, which are paid,
   network-bound, and provider-versioned (production is Gemini Embedding 2 Preview, 1536 dims) — so
   the same fixture can drift as the provider model changes. Options, none yet chosen:
   - **Record/replay** — snapshot the embedding vectors for the fixture and replay them, so runs are
     deterministic and offline. Pins the harness to a specific provider/model version of the vectors.
   - **Local Ollama embedding model** — cheap and offline, but a *different* embedding space than
     production, so the score is "is retrieval internally consistent," not "does production retrieve."
   - **Skip CI entirely** — keep it a manual, against-a-live-stack tool. Simplest; gives up automated
     regression detection.
2. **Assert vs report.** Should the harness *assert* a regression threshold (exit non-zero if
   recall@k drops below a floor) so it can gate a change, or only *report* numbers for a human to
   read? Asserting needs a stable baseline, which depends on (1).
3. **Corpus isolation from a real store.** How to keep the eval corpus from polluting (and being
   polluted by) a real memory store: a dedicated `client_id` / `collection` value filtered on every
   query, vs a throwaway disposable database/container per run. A throwaway DB is cleanest but heavier
   to stand up; a reserved `client_id` is lighter but risks cross-contamination of metrics.
4. **`id`-preserving import vs plan 007 / SEC-07.** The harness relies on
   `POST /export/import` honoring a caller-supplied `id` (`api/src/routes/export.js:168`) so labeled
   queries can name stable `expected_ids`. **Plan 007 / SEC-07** proposes constraining caller-set
   ids. If that lands, fixtures can no longer pin ids directly and the harness must instead seed,
   read back the server-assigned ids (e.g. via `GET /export`), and map fixture labels → real ids
   before querying. Coordinate so the two changes don't silently break each other.
5. **recall@k definition — hit vs fraction.** This spike uses the "hit@k" form (1 if *any* expected
   id is in top-k). For multi-answer queries a "fraction of expected ids found in top-k" form is more
   informative. Pick one (or report both) before the fixture set grows multi-answer queries.
6. **Seeding determinism under dedup.** Because import dedups on `content_hash`
   (`api/src/routes/export.js:157`), repeat runs against a non-empty store report `skipped` rather
   than re-seeding. Decide whether the harness should require an empty store, auto-clean its corpus
   before seeding, or tolerate `skipped` as a no-op (today it tolerates and reports).
