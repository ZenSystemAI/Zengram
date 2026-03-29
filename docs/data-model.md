# Data Model Deep Dive

## Memory Types

The system supports four memory types, each with different lifecycle behaviors:

| Type | Behavior | Expires? | Decays? | Supersedes? |
|------|----------|----------|---------|-------------|
| `event` | Append-only log entry | Yes (30d TTL) | No | No |
| `fact` | Upsertable knowledge | No | Yes | Yes (by `key`) |
| `decision` | Immutable record | No | No | No |
| `status` | Current state tracker | No | Yes | Yes (by `subject`) |

### event

Something that happened. Append-only -- events are never superseded. After 30 days (configurable via `EVENT_TTL_DAYS`), events with `access_count=0` and importance `medium` or `low` are soft-deleted by the consolidation cleanup.

### fact

Persistent knowledge that evolves over time. Facts should always include a `key` for clean lifecycle management. When a new fact is stored with a `key` matching an existing active fact:
1. The old fact is marked `active: false`
2. The old fact gets `superseded_by: new_id` and `superseded_at: timestamp`
3. The old fact's `valid_to` is set to the current time
4. The new fact gets `supersedes: old_id`

Facts without a `key` generate a console warning -- they pile up forever with no supersedes mechanism.

### decision

A choice made and the reasoning behind it. Decisions are immutable and never expire, decay, or get superseded. They serve as an audit trail.

### status

The current state of a system, workflow, or process. Statuses should always include a `subject`. When a new status is stored with a `subject` matching an existing active status, the same supersedes logic as facts applies.

## Memory Payload Schema

Every memory stored in Qdrant has this payload structure:

```json
{
  "text": "The memory content (scrubbed of credentials)",
  "type": "fact",
  "source_agent": "claude-code",
  "observed_by": ["claude-code"],
  "observation_count": 1,
  "client_id": "acme-corp",
  "category": "semantic",
  "importance": "high",
  "knowledge_category": "technical",
  "content_hash": "abc123def456ab",
  "created_at": "2026-03-15T10:00:00.000Z",
  "last_accessed_at": "2026-03-29T12:00:00.000Z",
  "access_count": 7,
  "confidence": 1.0,
  "active": true,
  "consolidated": false,
  "supersedes": null,
  "superseded_by": null,
  "key": "acme-tech-stack",
  "subject": null,
  "status_value": null,
  "valid_from": "2026-03-15T10:00:00.000Z",
  "valid_to": null,
  "entities": [
    {"name": "acme-corp", "type": "client"},
    {"name": "Next.js", "type": "technology"}
  ],
  "metadata": {}
}
```

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Memory content after credential scrubbing |
| `type` | string | `event`, `fact`, `decision`, `status` |
| `source_agent` | string | Agent that originally stored this memory |
| `observed_by` | string[] | All agents that have stored identical content (corroboration) |
| `observation_count` | number | Length of `observed_by` (capped at 20) |
| `client_id` | string | Client scope (`"global"` for system-wide) |
| `category` | string | `semantic` (concepts), `episodic` (events), `procedural` (how-to) |
| `importance` | string | `critical`, `high`, `medium`, `low` |
| `knowledge_category` | string | `brand`, `strategy`, `meeting`, `content`, `technical`, `relationship`, `general` |
| `content_hash` | string | First 16 chars of SHA256 of scrubbed content |
| `created_at` | string | ISO 8601 creation timestamp |
| `last_accessed_at` | string | ISO 8601 -- updated on every search hit |
| `access_count` | number | Incremented on every search hit |
| `confidence` | number | Base confidence (always 1.0 at creation) |
| `active` | boolean | `false` = soft-deleted or superseded |
| `consolidated` | boolean | `true` after consolidation engine has processed it |
| `supersedes` | string | UUID of the memory this one replaced (or null) |
| `superseded_by` | string | UUID of the memory that replaced this one (or null) |
| `key` | string | Facts only: unique key for upsert matching |
| `subject` | string | Status only: what this status is about |
| `status_value` | string | Status only: the status value |
| `valid_from` | string | Facts/statuses: when this became true |
| `valid_to` | string | Facts/statuses: when this stopped being true (null = still valid) |
| `entities` | object[] | Extracted entities: `[{name, type}]` |
| `metadata` | object | Arbitrary user metadata |

## Deduplication

Deduplication is tenant-scoped and runs at write time (not async). The process:

1. Content is scrubbed of credentials
2. SHA256 hash is computed and truncated to 16 hex characters
3. Qdrant is queried for existing points matching `content_hash` + `client_id` + `type` + `active: true`
4. If a match is found:
   - **Same agent**: Return the existing memory ID (true dedup, no write)
   - **Different agent**: Record cross-agent corroboration by appending to `observed_by` array

The `observed_by` array is capped at `MAX_OBSERVED_BY = 20` to prevent unbounded growth. Once the cap is reached, additional corroboration is acknowledged in the response but not recorded.

### Consolidation Dedup

The consolidation engine has its own dedup layer for merged facts:

1. **Exact dedup**: Check `content_hash` against existing active memories
2. **Semantic dedup**: Embed the merged fact, search for similar active memories. If any result has cosine similarity >= 0.92 (`SEMANTIC_DEDUP_THRESHOLD`), skip the merge.

## Supersedes Mechanism

Supersedes creates a version chain for facts and statuses:

```
fact_v1 (key: "acme-stack")
  active: false
  superseded_by: fact_v2
  superseded_at: 2026-03-20T...
  valid_to: 2026-03-20T...

fact_v2 (key: "acme-stack")
  active: true
  supersedes: fact_v1
  valid_from: 2026-03-20T...
  valid_to: null
```

When a fact/status is superseded:
1. Old memory: `active=false`, `superseded_by=new_id`, `superseded_at=now`, `valid_to=now`
2. New memory: `supersedes=old_id`, `valid_from=now` (or provided value), `valid_to=null`
3. Old memory is deactivated in keyword search index
4. Webhook notification `memory_superseded` is dispatched

By default, search excludes superseded memories (`active: true` filter). Pass `include_superseded=true` to see the full version history.

## Temporal Validity

Facts and statuses support temporal validity windows:

| Field | Default | Purpose |
|-------|---------|---------|
| `valid_from` | `created_at` | When this fact became true |
| `valid_to` | `null` | When this fact stopped being true (`null` = still valid) |

The `at_time` search parameter enables temporal queries: "what was true at time X?"

When `at_time` is provided, search adds range filters:
- `valid_from <= at_time`
- The Qdrant query returns only memories where `valid_from` is before the requested time

This enables historical queries like "what tech stack did acme use in January?" even after the fact has been superseded.

## Confidence Decay

Confidence decay prevents stale facts and statuses from dominating search results. It only applies to `fact` and `status` types -- events and decisions are historical records that don't decay.

### Formula

```
effective_confidence = base_confidence * (DECAY_FACTOR ^ days_since_last_access)
```

Where:
- `base_confidence` = `payload.confidence` (always 1.0 at creation)
- `DECAY_FACTOR` = 0.98 (configurable via env var, default 2% per day)
- `days_since_last_access` = days since `last_accessed_at` (or `created_at` if never accessed)

### Decay Curve

| Days Without Access | Effective Confidence |
|---------------------|---------------------|
| 0 | 1.000 |
| 7 | 0.869 |
| 14 | 0.755 |
| 30 | 0.545 |
| 60 | 0.297 |
| 90 | 0.162 |

The stats endpoint reports `decayed_below_50pct` -- the count of facts with effective confidence below 0.5 (sampled from a random 100 facts).

### How Access Prevents Decay

Every time a memory appears in search results:
1. `access_count` is incremented
2. `last_accessed_at` is updated to current time

This resets the decay clock. Frequently-accessed memories stay confident; forgotten ones fade.

## Search Scoring

Final search ranking combines multiple signals:

### 1. Vector Similarity Score

Cosine similarity from Qdrant (0.0 to 1.0). A minimum threshold of 0.3 filters out irrelevant results.

### 2. Confidence Decay

Applied as described above. Only affects facts and statuses.

### 3. Access Boost

```
access_boost = 1 + (0.3 * log2(access_count + 1))
```

| Access Count | Boost Factor |
|--------------|-------------|
| 0 | 1.000 |
| 1 | 1.300 |
| 3 | 1.600 |
| 7 | 1.900 |
| 15 | 2.200 |

### 4. Effective Score

```
effective_score = vector_score * effective_confidence * access_boost
```

Results are sorted by `effective_score` descending. In compact format, scores are rounded to 4 decimal places.

### 5. RRF Fusion (Multi-Path)

When multi-path retrieval is active (default), results from vector, keyword, and graph searches are merged using Reciprocal Rank Fusion before confidence decay and access boost are applied.

**RRF Formula**: `rrf_score(d) = sum(1 / (k + rank))` across all ranked lists where `d` appears.

- `k` = 60 (configurable via `RRF_K`). Higher values give more equal weight across ranks.
- Items appearing in multiple lists (e.g., found by both vector and keyword search) get boosted.
- Items missing from a list simply don't contribute score from that list (no penalty).

The three retrieval paths:

| Path | Source | How It Ranks |
|------|--------|-------------|
| Vector | Qdrant cosine similarity | By similarity score |
| Keyword | Postgres `ts_rank_cd` or SQLite FTS5 `rank` | By BM25 text relevance |
| Graph | BFS spreading activation through entity graph | By aggregate activation score |

## Entity Extraction

Entities are extracted from memory content at write time using a fast-path approach (no LLM calls):

### Extraction Pipeline

1. **Client ID** -- If `client_id` is not `"global"`, it becomes a `client` entity
2. **Source agent** -- Always extracted as an `agent` entity
3. **Domain names** -- Regex: `*.com`, `*.ca`, `*.io`, etc. Typed as `domain`
4. **Known technology names** -- Dictionary of 70+ tech names with canonical forms (e.g., "nextjs" -> "Next.js"). Pre-compiled regex per keyword.
5. **Known system names** -- Dictionary of internal system/product names (e.g., "agency system", "shared brain")
6. **Quoted names** -- Text in quotes/backticks (3-60 chars), filtered by junk detection
7. **Capitalized multi-word phrases** -- Regex for `Capitalized Word Patterns`, filtered by junk detection

### Junk Filtering

The extractor uses pattern-based filtering to avoid false positives:

- **Action verb prefixes**: "Fixed Something", "Added Feature" -- these are log messages, not entities
- **Noise words at start**: "The System", "This Feature" -- determiners, not names
- **Time words**: "Monday Meeting", "January Update"
- **CSS-like patterns**: "Background Color", "Border Radius"
- **Generic tail words**: "Error Fix", "Data Type", "Page View"
- **File paths, HTML, code**: Anything containing `/`, `\`, `<`, `{`, etc.
- **Prose fragments**: Phrases where >40% of words are common English/French prose words
- **camelCase/snake_case**: Variable names, not entity names

### Alias Cache

An in-memory alias cache maps alternative names to canonical entities:

- Pre-loaded with 70+ built-in tech name mappings
- Extended at startup from the structured store's `entity_aliases` table
- Updated in real-time when consolidation discovers new entities/aliases

When extraction encounters a name that matches an alias, it resolves to the canonical entity name and type.

### Entity Linking

After extraction, entities are linked to memories in the structured store:

1. For each extracted entity, find or create the entity record
2. Create an `entity_memory_link` (entity_id, memory_id, role)
3. Create `co_occurrence` relationships between all entities in the same memory

Roles: `about` (client_id), `source` (source_agent), `mentioned` (found in content).

## Knowledge Categories

Memories can be classified into knowledge domains:

| Category | What It Covers |
|----------|---------------|
| `brand` | Voice, identity, guidelines, visual standards |
| `strategy` | Plans, positioning, campaigns, competitive analysis |
| `meeting` | Call notes, action items, client conversations |
| `content` | Published work, content performance, editorial |
| `technical` | Hosting, CMS, SEO issues, infrastructure, code |
| `relationship` | Contacts, preferences, communication style |
| `general` | Default when no specific category fits |

The consolidation engine reclassifies memories with `general` or null categories to more specific ones based on content analysis. Only reclassifies from `general` -- never overwrites a specific category.

## Entity Relationships

Entities can have typed relationships:

| Type | Meaning | Example |
|------|---------|---------|
| `contact_of` | Person is a contact of a client | "Jean -> acme-corp" |
| `same_owner` | Entities share ownership | "site-a.com -> site-b.com" |
| `uses` | Entity uses another entity | "acme-corp -> Next.js" |
| `works_on` | Agent/person works on a project | "claude-code -> acme-corp" |
| `competitor_of` | Competitive relationship | "acme -> rival-corp" |
| `co_occurrence` | Appear together in memories (auto-generated) | any pair |

Relationships have a `strength` counter that increments each time the relationship is created/observed. The graph search uses `strength` to weight BFS traversal: `strengthFactor = min(strength / 5, 1.0)`.

### Graph Search (BFS Spreading Activation)

The graph search traverses entity relationships starting from entities mentioned in the query:

1. Extract entities from query text (fast-path regex)
2. Resolve to entity IDs in the store
3. BFS with activation decay:
   - Seed entities start with activation 1.0
   - Each hop decays by `GRAPH_SEARCH_DECAY` (default 0.8)
   - Typed relationships (uses, works_on, etc.) get `CAUSAL_BOOST` (default 2.0x)
   - `co_occurrence` relationships get no boost
   - Stop at `MAX_DEPTH` (default 2) or when activation < 0.1
4. Collect all memory IDs linked to activated entities
5. Sum activation scores per memory (memories linked to multiple activated entities score higher)

## Consolidation Pipeline

The consolidation engine runs on a cron schedule (default: every 6 hours) and processes all unconsolidated memories:

### What It Produces

| Output | Action | Stored As |
|--------|--------|-----------|
| Merged facts | Creates new fact, supersedes source memories | `type: fact`, `source_agent: consolidation-engine` |
| Contradictions | Flags for review | `type: event`, `importance: high` |
| Connections | Updates metadata on existing points | `connections` + `connection_description` fields |
| Entities | Creates/updates entities + aliases | Structured store entities/aliases tables |
| Knowledge categories | Reclassifies `general` -> specific | Updates `knowledge_category` payload field |
| Entity relationships | Creates typed relationships | Structured store entity_relationships table |
| Insights | **Disabled** (noise factory) | Skipped since 2026-03-19 |

### Merged Fact Dedup

Before storing a merged fact, the engine runs two checks:
1. Exact hash match against existing active memories
2. Semantic similarity check (embed + search): skip if any result >= 0.92 similarity

### Event Cleanup

After consolidation, the engine runs `cleanupOldEvents`:
- Scrolls all events with `type: event`
- Filters for: `active=true`, `access_count=0`, `created_at` older than `EVENT_TTL_DAYS` (default 30), `importance` is `medium` or `low`
- Soft-deletes matching events (sets `active: false`, `expired_at: now`)

### Batch Processing

- Memories are grouped by `client_id` for focused analysis
- Each group is processed in batches of 50 (to stay within LLM context limits)
- The LLM receives memories wrapped in XML tags (`<memory>`) to resist prompt injection
- All memory IDs in LLM output are validated against the current batch -- IDs from other batches are stripped

## Credential Scrubbing

The `scrub.js` service removes sensitive patterns from content before storage:
- API keys, passwords, tokens
- Connection strings with credentials
- Bearer tokens

This runs on every store path (POST /memory, webhook, import).

## Cross-References

- [Architecture](architecture.md) -- data flow diagrams
- [API Reference](api-reference.md) -- endpoint schemas
- [MCP Tools](mcp-tools.md) -- tool parameters for each concept
- [Configuration](configuration.md) -- decay, TTL, RRF tuning
