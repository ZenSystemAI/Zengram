# Operational Runbook

## Deployment

### Prerequisites

- Docker and Docker Compose installed
- An embedding API key (OpenAI, Gemini, or local Ollama)
- A `BRAIN_API_KEY` for authentication

### Initial Setup

```bash
# Clone and configure
cd /path/to/zengram
cp .env.example .env
# Edit .env — at minimum set BRAIN_API_KEY and an embedding key

# Start core services (Postgres + API)
docker-compose up -d

# Verify health
curl http://localhost:8084/health
# Expected: {"status":"ok","service":"zengram","timestamp":"..."}
```

### Postgres Connection

```bash
# .env (Postgres is the only structured/vector backend):
# STRUCTURED_STORE=postgres
# POSTGRES_URL=postgresql://brain:brain_secret@zengram-postgres:5432/shared_brain

# Restart API to pick up changes
docker-compose restart memory-api
```

### Rebuild After Code Changes

```bash
docker-compose up -d --build memory-api
```

### View Logs

```bash
# All services
docker-compose logs -f

# API only
docker-compose logs -f memory-api

# Postgres only
docker-compose logs -f postgres
```

## Health Monitoring

### Endpoints to Watch

| Endpoint | Auth | What It Returns |
|----------|------|-----------------|
| `GET /health` | No | `{"status":"ok"}` -- basic liveness |
| `GET /stats` | Yes | Full health dashboard: memory counts, decay stats, retrieval status |
| `GET /consolidate/status` | Yes | Consolidation engine state: running, last_run_at, LLM info |

### Stats Response Breakdown

```bash
curl -H "x-api-key: YOUR_KEY" http://localhost:8084/stats
```

Key fields to monitor:

| Field | Healthy | Warning |
|-------|---------|---------|
| `total_memories` | Growing steadily | Stagnant (agents not storing) or spiking (dedup broken) |
| `active` / `superseded` | Ratio depends on usage | If superseded >> active, consolidation is working |
| `decayed_below_50pct` | Low (< 5% of facts) | High count means facts are going stale without access |
| `retrieval.multi_path` | `true` | `false` means only vector search is active |
| `retrieval.keyword_search` | `true` | `false` if the keyword index is unavailable |
| `entities.total` | Growing | Zero means entity extraction is failing |

## Common Failure Modes

### 1. Express Health Check Failing (High Vector Count)

**Symptom**: Docker reports `zengram-api` as unhealthy. API requests time out or return 502.

**Root Cause**: At high vector counts, some Postgres operations (scroll, count) can exceed the request timeout. The health check itself is lightweight (`GET /health` does not query the database), but heavy API operations can cause cascading slowness.

**Resolution**:
- Run consolidation to merge/expire old memories and reduce the table size
- Monitor `total_memories` via `/stats` and consolidate proactively
- Ensure the pgvector HNSW and payload indexes exist (they are created at startup)

**Lesson learned**: Exact count queries over the full table are the bottleneck at scale. The stats endpoint runs several count queries in parallel; under load this can pressure Postgres.

### 2. Postgres Out of Memory

**Symptom**: Postgres container killed by OOM, restarts repeatedly.

**Resolution**:
- Check vector count via `/stats` (`vectors_count`)
- Each 3072-dim float32 vector uses ~12KB; an HNSW index adds graph overhead
- Reduce dimensions: switch to 1536 (`GEMINI_EMBEDDING_DIMS=1536`) -- Gemini supports Matryoshka
- Add memory limits to Docker: edit `docker-compose.yml` to add `mem_limit: 2g`
- Run consolidation to expire unused old events

### 3. Gemini / OpenAI Embedding Rate Limits

**Symptom**: `429 Too Many Requests` errors in logs during bulk import or consolidation.

**Resolution**:
- Import endpoint already batches in groups of 10 with 100ms delay between batches
- For Gemini: the free tier has low RPM limits; consider switching to OpenAI or Ollama
- The consolidation engine embeds each merged fact individually -- at high volumes this can hit rate limits
- Temporary fix: increase `CONSOLIDATION_INTERVAL` to reduce frequency

### 4. Consolidation LLM Failures

**Symptom**: `[consolidation] Scheduled run failed` in logs. Memories accumulate without being consolidated.

**Resolution**:
- Check `/consolidate/status` for LLM provider info
- Verify the LLM API key is valid (OPENAI_API_KEY for OpenAI, ANTHROPIC_API_KEY for Anthropic)
- Check the model name in `CONSOLIDATION_MODEL` is accessible from your account
- The consolidation engine parses JSON from LLM output; malformed responses are logged and skipped
- Manual trigger: `curl -X POST -H "x-api-key: KEY" http://localhost:8084/consolidate?sync=true`

### 5. Entity Alias Cache Empty

**Symptom**: Entity extraction works but doesn't resolve aliases. Entities extracted as new instead of matching existing ones.

**Resolution**:
- The cache loads at startup from the structured store
- If the store was empty on first boot, the cache starts with only built-in tech names (~70 entries)
- After consolidation discovers entities, restart the API to reload the cache
- Check: `curl -H "x-api-key: KEY" http://localhost:8084/entities/stats`

### 6. Keyword Search Not Working

**Symptom**: `retrieval.keyword_search: false` in stats. Only vector search results returned.

**Resolution**:
- Keyword search requires `STRUCTURED_STORE=postgres` (the only supported backend)
- The `memory_search` table needs a `content_tsv` generated column with a GIN index (created at startup)
- Run the keyword backfill script if existing memories predate the index

## Backup and Restore

### Export Memories

```bash
# Export all active memories (default limit 1000, max 5000)
curl -H "x-api-key: KEY" \
  "http://localhost:8084/export?limit=5000" > brain-backup.json

# Export specific client
curl -H "x-api-key: KEY" \
  "http://localhost:8084/export?client_id=acme-corp&limit=5000" > acme-backup.json

# Export with pagination (offset support)
curl -H "x-api-key: KEY" \
  "http://localhost:8084/export?offset=0&limit=1000" > page1.json
curl -H "x-api-key: KEY" \
  "http://localhost:8084/export?offset=1000&limit=1000" > page2.json
```

### Import Memories

```bash
# Import from backup (max 500 per call, deduplicates by content hash)
curl -X POST -H "x-api-key: KEY" \
  -H "Content-Type: application/json" \
  -d @brain-backup.json \
  http://localhost:8084/export/import

# Response: {"imported": 342, "skipped": 158, "errors": 0}
```

Import re-embeds with the current provider, so export and reimport is one way to switch embedding providers. For an existing deployment, the staged re-embed below switches in place without taking search down.

### Postgres Data Directory

Raw Postgres storage (vectors + structured tables) is at `./data/postgres/`. For a bare-metal snapshot:
```bash
docker-compose stop postgres
cp -r ./data/postgres ./data/postgres-backup-$(date +%Y%m%d)
docker-compose start postgres
```

For a logical dump instead:
```bash
docker exec zengram-postgres pg_dump -U brain shared_brain > brain-$(date +%Y%m%d).sql
```

## Switching Embedding Models (Staged Re-embed)

`api/scripts/reembed.js` moves the corpus to a new embedding provider, model, dimensionality or instruction prefix. It builds the replacement vectors in a separate `memories.vector_next` column, so the active `vector` column and its HNSW index keep serving search until a single cutover transaction. Staging never nulls or overwrites the active column.

Run it with the same `POSTGRES_URL` the API uses and the **target** embedding env (`EMBEDDING_PROVIDER` and that provider's model, dims and prefix variables). Inside the API container the script is at `/app/scripts/reembed.js`; pass the target env with `docker exec -e NAME=value ...`. Take a database snapshot first (see above).

```bash
# 1. Preview (default; no writes)
node api/scripts/reembed.js

# 2. Stage: embed every memory with text into vector_next and record the target
#    provenance. Resumable: rows already staged for the same generation and
#    content_hash are skipped, so rerun it after failures or to catch up on
#    memories written meanwhile.
node api/scripts/reembed.js --stage --apply

# 3. Preview the cutover: reports coverage and whether activation would be refused
node api/scripts/reembed.js --activate

# 4. Stop writers (or the API), run step 2 once more to catch up, then cut over
node api/scripts/reembed.js --activate --apply

# 5. Restart the API with the target embedding env
```

Activation runs in one transaction under an advisory lock and an `ACCESS EXCLUSIVE` lock on `memories`. It refuses, and rolls back without touching the active vectors, when:
- any memory with text has no staged vector, was staged under another generation, or was edited after staging (its `content_hash` changed);
- a memory has an active vector but no embeddable text (a dimension change would leave it without a vector);
- the recorded target provenance does not match the current embedding env (provider, model, dimensions, prefix fingerprints, normalization);
- `--limit` or `--collection` is passed, even empty or malformed (partial cutover is unsafe; both are allowed for staging tests, and a malformed value is rejected in every mode).

On success it copies the current vectors into `vector_prev`, promotes `vector_next` into `vector` (re-typing the column when the dimensionality changes), drops `vector_next`, and rebuilds `idx_memories_vector_hnsw`: a plain `vector` index up to 2000 dims, a `halfvec` cast index above that. Restart the API with the target env straight away: until then it embeds queries with the old model. After a dimensionality change, the startup dims guard refuses to start the API under the old env.

Every run ends with a `[reembed-summary]` JSON line and exits nonzero on stage failures or a refused activation. Migration provenance is kept in `zengram_meta`, with instruction prefixes stored as fingerprints only. `embedding_migration_target` holds the staged or active target, and `embedding_migration_previous` describes what `vector_prev` holds. Staging records the active identity under `embedding_migration_pending_previous`, and only activation moves it to `embedding_migration_previous`, so an abandoned stage never mislabels `vector_prev`. `vector_prev` is a one-generation snapshot for manual rollback: the next activation replaces it, and once you no longer need it, `ALTER TABLE memories DROP COLUMN vector_prev;` reclaims the space. To force a fresh stage under an unchanged configuration (for example after a provider updates a model in place), set `EMBEDDING_GENERATION` to a new value for both stage and activate. If you pin `EMBEDDING_GENERATION` and then change the provider, model, dimensions or a prefix, staging refuses to reuse the vectors staged under the old identity; set a new value.

## Restart Procedures

### Restart API Only (Config Change)

```bash
docker-compose restart memory-api
```

### Restart Everything

```bash
docker-compose down
docker-compose up -d
```

### Full Reset (Destructive)

```bash
docker-compose down -v
rm -rf ./data/postgres
docker-compose up -d
```

This destroys all memories and the entity graph. Only use for a clean start.

## Rate Limiting

The API enforces per-key rate limits:

| Request Type | Default Limit | Window | Configurable Via |
|--------------|--------------|--------|------------------|
| Writes (POST/PUT/PATCH/DELETE) | 60/min | 1 minute | `RATE_LIMIT_WRITES` |
| Reads (GET) | 120/min | 1 minute | `RATE_LIMIT_READS` |
| Consolidation (POST /consolidate) | 1/hour | 1 hour | Hardcoded |

When rate-limited, the API returns `429` with a `Retry-After` header.

## Auth Failure Protection

The auth middleware tracks failed authentication attempts per IP:
- After 10 failures within 60 seconds, the IP is blocked with `429`
- Uses timing-safe comparison to prevent timing attacks
- Failed attempt records are cleaned up every 5 minutes

## Log Prefixes

All log lines use bracketed prefixes for grep-friendly filtering:

| Prefix | Component |
|--------|-----------|
| `[zengram]` | Startup, shutdown, top-level events |
| `[pgvector]` | pgvector collection/index operations |
| `[embeddings]` | Embedding provider init/errors |
| `[store]` | Structured store operations |
| `[memory:store]` | POST /memory write path |
| `[memory:search]` | GET /memory/search |
| `[memory:query]` | GET /memory/query |
| `[memory:update]` | PATCH /memory/:id |
| `[memory:delete]` | DELETE /memory/:id |
| `[consolidation]` | Consolidation engine runs |
| `[entities]` | Entity extraction and alias cache |
| `[keyword-search]` | Keyword (full-text) search |
| `[collections]` | Multi-collection management |
| `[reflect]` | LLM reflection |
| `[reembed]` / `[reembed-summary]` | Staged re-embed script (`api/scripts/reembed.js`) |

## Cross-References

- [Architecture](architecture.md) -- system design and data flow
- [Configuration](configuration.md) -- every environment variable explained
- [API Reference](api-reference.md) -- endpoint details for manual debugging
