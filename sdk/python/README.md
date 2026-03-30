# Zengram — Python SDK

Python client for the [Zengram](https://github.com/ZenSystemAI/zengram) API. Store, search, and manage shared memories across AI agents.

## Install

```bash
pip install zengram
```

## Quick Start

```python
from zengram import BrainClient

brain = BrainClient(
    url="http://localhost:8084",
    api_key="your-api-key",
    source_agent="my-python-script",
)

# Store a fact
result = brain.store(
    type="fact",
    content="The deployment pipeline uses GitHub Actions",
    key="deploy-pipeline-tool",
    importance="high",
)
print(f"Stored: {result.id} (dedup: {result.deduplicated})")

# Search memories
response = brain.search("deployment pipeline", limit=5)
for r in response.results:
    print(f"  [{r.score:.2f}] {r.content[:80]}")

# Get a briefing
briefing = brain.briefing(since="2026-03-28T00:00:00Z")
print(f"Events: {briefing.summary['events']}, Facts: {briefing.summary['facts_updated']}")

# Check health
stats = brain.stats()
print(f"Total memories: {stats.total_memories}, Active: {stats.active}")
```

## Async Usage

```python
import asyncio
from zengram import AsyncBrainClient

async def main():
    async with AsyncBrainClient(url="http://localhost:8084", api_key="key", source_agent="async-agent") as brain:
        result = await brain.store(type="event", content="Async store works!")
        response = await brain.search("async")
        print(f"Found {response.count} results")

asyncio.run(main())
```

## API Reference

### Client Options

```python
BrainClient(
    url="http://localhost:8084",  # API base URL
    api_key="your-key",           # x-api-key for auth
    timeout=15.0,                 # Default request timeout (seconds)
    max_retries=3,                # Retry count for 429/503/timeout
    source_agent="my-agent",      # Default source_agent for all stores
)
```

### Memory Types

| Type | Behavior | Example |
|------|----------|---------|
| `event` | Append-only, immutable | "Deployment completed" |
| `fact` | Upsert by `key`, supersedes old version | "API status: healthy" |
| `status` | Update by `subject`, latest wins | "build-pipeline: passing" |
| `decision` | Append-only, records reasoning | "Chose Postgres over MySQL because..." |

### Methods

| Method | Description |
|--------|-------------|
| `store(type, content, ...)` | Store a memory |
| `search(query, ...)` | Multi-path semantic search (vector + BM25 + graph) |
| `query(type, ...)` | Structured query (facts by key, statuses by subject) |
| `briefing(since, ...)` | Session briefing — what happened since a time |
| `stats()` | Memory health stats |
| `entities(action, ...)` | Query the entity graph |
| `graph(entity, ...)` | Explore entity relationships |
| `client(client, ...)` | Get everything about a client |
| `consolidate(sync=False)` | Trigger LLM consolidation |
| `export(...)` | Export memories as JSON |
| `import_memories(data)` | Import from JSON |
| `delete(memory_id, ...)` | Soft-delete a memory |
| `update(memory_id, ...)` | Update memory fields in-place |
| `reflect(topic, ...)` | LLM synthesis of patterns across memories |
| `health()` | API health check (no auth) |

### Error Handling

```python
from zengram import BrainClient, BrainError, RateLimitError

brain = BrainClient(url="http://localhost:8084", api_key="key")

try:
    brain.search("test")
except RateLimitError as e:
    print(f"Rate limited, retry after {e.retry_after}s")
except BrainError as e:
    print(f"API error {e.status_code}: {e}")
```

### Typed Returns

Search results, briefings, stats, and graphs return typed dataclasses:

```python
response = brain.search("docker")
for result in response.results:
    print(result.id)              # str
    print(result.score)           # float
    print(result.effective_score) # float (with decay + access boost)
    print(result.type)            # str
    print(result.content)         # str
    print(result.entities)        # list[dict]

stats = brain.stats()
print(stats.total_memories)       # int
print(stats.by_type)              # dict[str, int]

graph = brain.graph("Docker")
print(graph.center)               # str
for node in graph.nodes:
    print(node.id, node.type)     # str, str
```

## Development

```bash
cd sdk/python
pip install -e ".[dev]"
pytest
```
