# Operational Runbook

## Deployment

### Prerequisites

- Docker and Docker Compose installed
- An embedding API key (OpenAI, Gemini, or local Ollama)
- A `BRAIN_API_KEY` for authentication

### Initial Setup

```bash
# Clone and configure
cd /path/to/multi-agent
cp .env.example .env
# Edit .env — at minimum set BRAIN_API_KEY, QDRANT_API_KEY, and an embedding key

# Start core services (Qdrant + API with SQLite)
docker-compose up -d

# Verify health
curl http://localhost:8084/health
# Expected: {"status":"ok","service":"shared-brain","timestamp":"..."}
```

### With Postgres (Production)

```bash
# Start with Postgres profile
docker-compose --profile postgres up -d

# Update .env:
# STRUCTURED_STORE=postgres
# POSTGRES_URL=postgresql://brain:brain_secret@postgres:5432/shared_brain

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

# Qdrant only
docker-compose logs -f qdrant
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
| `retrieval.keyword_search` | `true` | `false` if no structured store configured |
| `retrieval.graph_search` | `true` | `false` if no entity store (baserow/none backend) |
| `entities.total` | Growing | Zero means entity extraction is failing |

### Dashboard

Browse `http://localhost:8084/dashboard` for a visual stats overview. No authentication required for the HTML page; the embedded JavaScript uses the API key from the URL or prompts for one.

### Knowledge Graph Visualization

Browse `http://localhost:8084/graph/html?key=YOUR_KEY` for the interactive entity browser with D3.js force-directed graphs.

## Common Failure Modes

### 1. Express Health Check Failing (39K+ Vector Stress)

**Symptom**: Docker reports `shared-brain-api` as unhealthy. API requests time out or return 502.

**Root Cause**: At 39K+ vectors, some Qdrant operations (scroll, count) exceed the default timeout. The health check itself is lightweight (`GET /health` does not query Qdrant), but heavy API operations can cause cascading slowness.

**Resolution**:
- Increase Qdrant timeout: `QDRANT_TIMEOUT_MS=15000` or `20000` (default is 10000)
- The `scrollPoints` function uses this timeout for all Qdrant HTTP requests
- Run consolidation to merge/expire old memories and reduce collection size
- Monitor `total_memories` via `/stats` and consolidate proactively

**Lesson learned**: The 39K vector stress test revealed that Qdrant count queries with `exact: true` are the bottleneck at scale. The stats endpoint runs 6+ count queries in parallel; under load this can saturate Qdrant.

### 2. Qdrant Out of Memory

**Symptom**: Qdrant container killed by OOM, restarts repeatedly.

**Resolution**:
- Check vector count: `curl http://localhost:6334/collections/shared_memories`
- Qdrant stores vectors in memory; each 3072-dim float32 vector uses ~12KB
- At 50K vectors with 3072 dims: ~600MB RAM minimum
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
- Keyword search requires `STRUCTURED_STORE=sqlite` or `STRUCTURED_STORE=postgres`
- If set to `baserow` or `none`, keyword search is disabled
- For Postgres: the `memory_search` table needs a `content_tsv` generated column with GIN index
- For SQLite: the `memory_search_fts` FTS5 virtual table is created automatically

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

Import re-embeds with the current provider, so switching embedding providers is safe -- just export and reimport.

### Qdrant Data Directory

Raw Qdrant storage is at `./data/qdrant/`. For bare-metal backup:
```bash
docker-compose stop qdrant
cp -r ./data/qdrant ./data/qdrant-backup-$(date +%Y%m%d)
docker-compose start qdrant
```

### SQLite Database

```bash
cp ./data/brain.db ./data/brain-backup-$(date +%Y%m%d).db
```

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
rm -rf ./data/qdrant ./data/brain.db ./data/postgres
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
| `[shared-brain]` | Startup, shutdown, top-level events |
| `[qdrant]` | Qdrant collection/index operations |
| `[embeddings]` | Embedding provider init/errors |
| `[store]` | Structured store operations |
| `[memory:store]` | POST /memory write path |
| `[memory:search]` | GET /memory/search |
| `[memory:update]` | PATCH /memory/:id |
| `[memory:delete]` | DELETE /memory/:id |
| `[consolidation]` | Consolidation engine runs |
| `[entities]` | Entity extraction and alias cache |
| `[keyword-search]` | BM25 keyword search |
| `[webhook:n8n]` | n8n webhook ingestion |
| `[subscribe]` | SSE subscription lifecycle |
| `[notifications]` | Webhook dispatch |
| `[auth]` | Agent key loading |
| `[reflect]` | LLM reflection |

## Cross-References

- [Architecture](architecture.md) -- system design and data flow
- [Configuration](configuration.md) -- every environment variable explained
- [API Reference](api-reference.md) -- endpoint details for manual debugging
