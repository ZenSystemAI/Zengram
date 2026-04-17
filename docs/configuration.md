# Configuration Reference

All configuration is via environment variables, defined in `.env` (loaded by Docker Compose via `env_file`). See `.env.example` for a commented template.

## Required Variables

| Variable | Example | Description |
|----------|---------|-------------|
| `ZENGRAM_API_KEY` | `openssl rand -hex 32` | Admin API key. Required for startup. Full access, no agent identity binding. |
| `PORT` | `8084` | Express server port. |

## Server

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` for LAN/Docker access. The `docker-compose.yml` overrides this to `0.0.0.0` inside the container. |
| `API_BIND` | `127.0.0.1` | Docker port binding address. Set to `0.0.0.0` in `.env` to expose the API on all interfaces from the host. |

## Authentication (v4)

Per-agent API keys were retired in v4. A single admin key (`BRAIN_API_KEY`) authenticates every caller, and all writes are attributed to `source_agent: "claude-code"` regardless of which Claude variant or machine made the call. This collapsed `ti-claude`, `mini-claude`, `morpheus`, `neo`, `autolab`, and `n8n` into one canonical identity.

## Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_WRITES` | `60` | Max write requests (POST/PUT/PATCH/DELETE) per minute per API key |
| `RATE_LIMIT_READS` | `120` | Max read requests (GET) per minute per API key |

Consolidation POST is hardcoded to 1 per hour per key (not configurable).

## Qdrant (Vector Store)

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_URL` | `http://qdrant:6333` | Qdrant HTTP API URL. Use `http://qdrant:6333` inside Docker, `http://localhost:6334` from host. |
| `QDRANT_API_KEY` | (none) | Qdrant API key for authentication. Must match `QDRANT__SERVICE__API_KEY` in docker-compose. |
| `QDRANT_TIMEOUT_MS` | `10000` | Timeout for all Qdrant HTTP requests in ms. Increase to 15000-20000 at 30K+ vectors. |

### Qdrant Performance Notes

At the 39K vector stress test, `QDRANT_TIMEOUT_MS=10000` caused timeout failures on count queries with `exact: true`. The stats endpoint runs 6 parallel count queries which can saturate Qdrant under load. Increase this timeout proactively as your collection grows.

## Embedding Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `openai` | Provider: `openai`, `gemini`, `ollama` |

### OpenAI Embeddings

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required if provider=openai) | OpenAI API key |

Uses `text-embedding-3-small` (1536 dimensions).

### Gemini Embeddings

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | (required if provider=gemini) | Google Gemini API key |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-2-preview` | Gemini embedding model name |
| `GEMINI_EMBEDDING_DIMS` | `3072` | Output dimensions. Supports Matryoshka: 3072, 1536, 768 |

Gemini uses task-specific embeddings: `RETRIEVAL_DOCUMENT` for storage, `RETRIEVAL_QUERY` for search. This improves retrieval quality but means you cannot mix providers between store and search.

**Dimension tradeoffs**: 3072 gives best quality but uses more Qdrant RAM (~12KB per vector). 1536 is a good balance. 768 for minimal footprint.

### Ollama Embeddings

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API URL |
| `OLLAMA_MODEL` | `nomic-embed-text` | Ollama embedding model |

Dimensions are auto-detected from the model on first embed.

## Structured Storage Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `STRUCTURED_STORE` | `sqlite` | Backend: `sqlite`, `postgres`, `baserow`, `none` |

### SQLite

| Variable | Default | Description |
|----------|---------|-------------|
| `SQLITE_PATH` | `./data/brain.db` | SQLite database file path |

SQLite is the default. Supports all features: events, facts, statuses, entities, aliases, relationships, FTS5 keyword search. Good for single-node deployments.

### Postgres

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_URL` | (required if store=postgres) | Connection string: `postgresql://user:pass@host:5432/dbname` |
| `POSTGRES_PASSWORD` | `brain_secret` | Used by docker-compose for the optional Postgres container |

Postgres provides full BM25 via `tsvector` with GIN index. Recommended for production or when keyword search quality matters.

### None

Set `STRUCTURED_STORE=none` to run with Qdrant only. Disables: structured queries (`/memory/query`), keyword search, entity store. Vector search still works.

## Consolidation Engine

| Variable | Default | Description |
|----------|---------|-------------|
| `CONSOLIDATION_ENABLED` | `true` | Set to `false` to disable entirely |
| `CONSOLIDATION_INTERVAL` | `0 */6 * * *` | Cron expression for scheduled runs (default: every 6 hours) |
| `CONSOLIDATION_MIN_CORPUS` | `1500` | Skip scheduled runs if active corpus is below this size. Manual `POST /consolidate` always runs. |
| `CONSOLIDATION_LLM` | `openai` | LLM provider: `openai`, `anthropic`, `ollama`, `gemini` |
| `CONSOLIDATION_MODEL` | `gpt-4o-mini` | Model name |
| `ANTHROPIC_API_KEY` | (for anthropic provider) | Anthropic API key |

The consolidation engine processes memories in batches of 50, grouped by client_id. It:
- Merges duplicate facts
- Flags contradictions
- Discovers and links entities
- Reclassifies knowledge categories
- Creates entity relationships
- Cleans up old events

### Gating (v4)

Scheduled consolidation is now gated by corpus size. If the active corpus is below `CONSOLIDATION_MIN_CORPUS` (default 1500), the scheduled run is skipped — consolidation has almost no work to do on small corpora and the LLM calls are wasted. To force a run regardless of size, `POST /consolidate` manually.

### When to change the interval

- **High volume** (>100 memories/day): Consider `0 */3 * * *` (every 3 hours)
- **Low volume** (<10 memories/day): `0 0 * * *` (once daily) is sufficient
- **Manual only**: Set `CONSOLIDATION_ENABLED=false` and trigger via API when needed

## Memory Decay

| Variable | Default | Description |
|----------|---------|-------------|
| `DECAY_FACTOR` | `0.98` | Per-day decay multiplier. Only affects `fact` and `status` types. |

Formula: `effective_confidence = confidence * (DECAY_FACTOR ^ days_since_last_access)`

| DECAY_FACTOR | Days to 50% | Behavior |
|--------------|-------------|----------|
| 0.99 | 69 days | Very slow decay, memories stay relevant longer |
| 0.98 | 34 days | Default. Unused facts fade in ~1 month |
| 0.95 | 14 days | Aggressive. Facts need access every 2 weeks to stay relevant |

Events and decisions never decay -- they are historical records.

## Event TTL

| Variable | Default | Description |
|----------|---------|-------------|
| `EVENT_TTL_DAYS` | `30` | Auto-expire events after N days if never accessed and medium/low importance |

The consolidation cleanup only expires events that meet ALL criteria:
- `type: event`
- `active: true`
- `access_count: 0`
- `created_at` older than TTL
- `importance: medium` or `importance: low`

Critical and high-importance events are never auto-expired. Events that have been accessed at least once are never auto-expired.

## Hybrid Retrieval

| Variable | Default | Description |
|----------|---------|-------------|
| `MULTI_PATH_SEARCH` | `true` | Enable parallel vector + keyword (BM25) search with RRF fusion |
| `RRF_K` | `60` | RRF smoothing constant. Range 50-100. Higher = more equal weighting across ranks. |

**RRF_K tuning**: Lower values (50) give more weight to top-ranked items in each list. Higher values (100) flatten the distribution, giving later-ranked items more influence. Default of 60 works well for most cases.

Graph BFS search was removed in v4. At the current scale (~500 active memories), vector + BM25 was catching everything the graph path was contributing, and the graph machinery (entity-relationships table, BFS traversal, co-occurrence scoring) added complexity without measurable retrieval lift. The `entities` table and alias cache are still maintained for coreference and stats.

## MCP Server Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAIN_MCP_TIMEOUT` | `15000` | Default timeout for MCP-to-API calls in ms |
| `BRAIN_MCP_CONSOLIDATION_TIMEOUT` | `120000` | Timeout for sync consolidation and reflect calls in ms |

The MCP server applies these timeouts to all `fetch()` calls to the API. Consolidation and reflect use the longer timeout because they involve LLM calls that can take 30-60 seconds.

## Cross-References

- [Architecture](architecture.md) -- how these variables map to components
- [Operations](operations.md) -- deployment and monitoring
- [Data Model](data-model.md) -- decay formula, scoring details
