# Change encoders without overwriting active vectors

`reembed.js` replaces `memories.vector` in place. On a dimension change it drops
HNSW and clears that column before filling it again. For larger corpora, use
[Ptah inference migrations](https://docs.ptah.run/v0.11.4/inference/overview/) to build
and verify a separate column while the existing API keeps serving the old one.

```mermaid
flowchart LR
    API[API + current encoder] --> V[memories.vector + existing HNSW]
    P[Ptah + replacement encoder] --> C[memories.embedding_v2 + new HNSW]
    C --> Check[Catch up and verify]
    Check --> Deploy[Deploy matching encoder + PGVECTOR_COLUMN]
    Deploy --> C
```

This is an opt-in operator workflow, tested with Ptah **0.11.4** and PostgreSQL
16. It does not add Ptah to the API image or change the default storage path.
The example uses an OpenAI-compatible replacement encoder with at most 2,000
dimensions and a `vector` HNSW index. The existing encoder may use any Zengram
provider. Native Gemini is not an OpenAI-compatible endpoint.

## Prepare once

Install `ptah` from its [release](https://github.com/stokaro/ptah/releases/tag/v0.11.4).
Keep the current API configuration and encoder running. Run these commands from
the repository root, with an explicit database URL for the intended database:

```sh
export POSTGRES_URL='postgres://user:password@localhost:5433/shared_brain?sslmode=disable'
psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 -f api/scripts/ptah/source.sql
```

`source.sql` exposes the text fallback used by `reembed.js` as a generated
`embedding_text` column. Ptah reads columns, while Zengram stores text inside
JSON payloads. The generated column also follows subsequent payload edits.
Adding a stored generated column rewrites the table and takes a table lock:
schedule this one-time setup separately, with enough disk space. Its five-second
lock timeout bounds waiting for a lock, not the rewrite duration. Do not rerun
it once the column exists.

## Build the candidate

Copy the example, then configure the new model's endpoint, identifier, reported
dimension, and document prefix:

```sh
cp api/scripts/ptah/embedding-v2.json embedding-v2.json
```

Ptah accepts JSON specifications as well as YAML. The prefix must equal the decoded
`EMBED_DOC_PREFIX` you will deploy. Do not trim, normalize, or truncate text
differently between backfill and API writes.

For a hosted endpoint, set `endpoint_class` to `hosted` and use a credential
reference such as `"credential": "env:OPENAI_API_KEY"`; do not put a key in the
file. If you request shortened dimensions in Zengram, set the same
`requested_dimension` in the specification. Leave it absent when the server
expects native dimensions. Keep credentials and private corpus text out of Git.

```sh
export PTAH_DB_URL="$POSTGRES_URL"
export PTAH_SPEC="$PWD/embedding-v2.json"
export PTAH_RUN_ID=memories-v2
ptah inference plan
ptah inference prepare
ptah inference backfill
ptah inference catchup
ptah inference index
ptah inference verify
```

Use a new column and run ID for every model change, including changes that keep
the same dimension. `prepare` adds the candidate column, metadata, and outbox
triggers. `catchup` brings inserts, text changes, and deletes into the candidate.
The original column and index remain in use. A failed backfill can be retried
with the same specification and run ID; it does not clear the active vectors.

Verification checks coverage, freshness, dimensions, and index readiness. It
does not establish that the new encoder retrieves better answers. Evaluate
representative queries with that model's query prefix before switching; see
[Ptah evaluation](https://docs.ptah.run/v0.11.4/inference/reference/evaluation-corpus/).

## Switch the encoder and column together

Briefly pause **all writers**, including consolidation jobs and imports. Drain
in-flight writes, catch up again, and verify before approving the switch:

```sh
ptah inference catchup
ptah inference verify
ptah inference cutover
# The unapproved command refuses and prints a plan digest. Review it, then:
ptah inference cutover --approve <digest> --approver 'operator name'
```

Ptah records the active generation. Zengram does **not** read that pointer:
its encoder and column are fixed for the lifetime of each API process. Deploy
them as one configuration change, for example:

```dotenv
PGVECTOR_COLUMN=embedding_v2
EMBEDDING_PROVIDER=openai
OPENAI_BASE_URL=http://encoder:8000/v1
OPENAI_EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
# Unset OPENAI_EMBEDDING_DIMS when the server uses native dimensions.
# Set EMBED_DOC_PREFIX and EMBED_QUERY_PREFIX to this model's expected values.
```

Point the API at the same model used by Ptah, even when its network address
differs. Startup checks the selected column's dimension and refuses a missing
or incompatible column. Dimension equality alone does not prove model equality.
Check search with the new API, retire old API processes, then resume writers.
Old processes can serve reads during preparation and this deployment, but must
not resume writing with the old configuration. This is not an automatic,
zero-downtime deployment controller.

Both normal writes and fact/status supersession now write the selected column.
The API leaves candidate index creation to Ptah. Keyword search, tenant and
collection filters, payloads, and entity extraction keep their existing paths.
Do not use `reembed.js` with a selected candidate column; it refuses that setup.

## Keep or discard the previous column

Before writers resume, the original vectors still provide a way to cancel the
application switch. Afterward they become stale: keeping a column is **not** a
complete rollback strategy. Do not switch back without rebuilding/catching up
that model's vectors and verifying them while writers are paused. This example
does not register the legacy column as a Ptah generation or provide automatic
rollback. Keep a database backup and both encoder configurations.

Outbox triggers remain installed after cutover. Schedule `ptah inference
catchup` with this specification and run ID to keep metadata current and drain
captured changes. Keep the active generation's specification; do not retire it
while the API still reads its column. Use Ptah's
[retirement guide](https://docs.ptah.run/v0.11.4/inference/guides/rollback-and-retire/)
when a generation is no longer needed.

## Reproduce the migration test

With Node.js, Ptah 0.11.4, and an **empty, disposable** pgvector database:

```sh
cd api
npm ci
POSTGRES_URL='postgres://postgres:test@localhost:5432/zengram_test?sslmode=disable' \
  node scripts/ptah/verify.js
```

The test runs real Zengram storage code and Ptah against PostgreSQL. A local,
deterministic embeddings endpoint simulates different dimensions and an outage.
It checks retry, old-column search during the build, catch-up of edits and
deletes, explicit cutover approval, writes after switching, and tenant/collection
filters. It does not call a paid provider or measure model quality. The test
refuses a database that already contains `memories`; discard the test database
afterward.
