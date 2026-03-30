# @zensystemai/zengram-mcp

MCP server for [Zengram](https://github.com/ZenSystemAI/zengram) — gives Claude Code, Cursor, and other MCP-compatible AI tools access to a shared memory system that works across agents and machines.

## Prerequisites

This package connects to the Zengram API. You need to run that first:

```bash
git clone https://github.com/ZenSystemAI/zengram.git
cd zengram
cp .env.example .env  # Set BRAIN_API_KEY, QDRANT_URL, QDRANT_API_KEY
docker compose up -d
```

## Installation

```bash
npm install -g @zensystemai/zengram-mcp
```

## Configuration

### Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "zengram": {
      "command": "zengram-mcp",
      "env": {
        "BRAIN_API_URL": "http://localhost:8084",
        "BRAIN_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cursor / Windsurf (`mcp.json`)

```json
{
  "mcpServers": {
    "zengram": {
      "command": "zengram-mcp",
      "env": {
        "BRAIN_API_URL": "http://your-server:8084",
        "BRAIN_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `BRAIN_API_KEY` | Yes | API key set in your `.env` |
| `BRAIN_API_URL` | No | API URL. Default: `http://localhost:8084` |

## Tools

| Tool | Description |
|------|-------------|
| `brain_store` | Store a memory (event, fact, decision, or status). Entities are automatically extracted. |
| `brain_search` | Semantic search across all memories. Supports `entity` filter for entity-scoped results. |
| `brain_briefing` | Session briefing — what happened since a given time, with entity summary. |
| `brain_query` | Structured query by type, key, subject, or time range. |
| `brain_stats` | Memory + entity health stats (totals, active, decayed, by type, top entities). |
| `brain_consolidate` | Trigger or check LLM consolidation (also extracts and normalizes entities). |
| `brain_entities` | Query the entity graph — list, get details, find linked memories, stats. |

## Usage Examples

### Session briefing

```
brain_briefing since="2026-03-11T00:00:00Z" agent="claude-code"
```

Returns categorized updates from all other agents — events, facts, decisions, status changes, and which entities were mentioned.

### Store a memory

```
brain_store type="fact" content="Client prefers dark mode UI" source_agent="claude-code" client_id="acme-corp" key="acme-ui-preference"
```

Stores a fact that any other agent can retrieve. Entities like "acme-corp" (client) are automatically extracted and linked.

### Search with entity filter

```
brain_search query="deployment issues" entity="Docker"
```

Semantic search filtered to only memories that mention Docker. Uses Qdrant's native payload index — no result-count ceiling.

### Query entities

```
brain_entities action="list" type="technology"
```

Lists all technology entities discovered across your memories.

```
brain_entities action="get" name="acme-corp"
```

Returns entity details including all known aliases and mention count.

```
brain_entities action="memories" name="Docker" limit=10
```

Returns memory links for a specific entity.

```
brain_entities action="stats"
```

Returns entity counts by type and top-mentioned entities.

### Memory health

```
brain_stats
```

Returns total count, active vs superseded, consolidated, breakdown by type, decay config, and entity statistics.

### Trigger consolidation

```
brain_consolidate action="run"
```

An LLM analyzes unconsolidated memories — merging duplicates, flagging contradictions, discovering connections, generating insights, and extracting/normalizing entities. The alias cache refreshes after each run.

```
brain_consolidate action="status"
```

Returns whether consolidation is running, when it last ran, and which LLM is configured.

## Memory Types

| Type | Behavior | When to Use |
|------|----------|-------------|
| `event` | Append-only, immutable | "Deployment completed", "Workflow failed" |
| `fact` | Upsert by `key` | Persistent knowledge that gets updated |
| `status` | Update-in-place by `subject` | Current state of a system or workflow |
| `decision` | Append-only | Choices made and why |

## Entity Types

Entities are automatically extracted from memory content. Supported types:

| Type | Examples |
|------|----------|
| `client` | Extracted from `client_id` field |
| `agent` | Extracted from `source_agent` field |
| `technology` | PostgreSQL, Docker, n8n, Redis, etc. (40+ built-in) |
| `domain` | example.com, api.acme.io |
| `workflow` | Quoted names, n8n workflow names |
| `person` | Capitalized proper nouns |
| `system` | Named systems and services |

The consolidation engine refines types and discovers aliases over time.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `BRAIN_API_KEY environment variable is required` | Set `BRAIN_API_KEY` in your MCP config `env` block |
| `API ... 401 Unauthorized` | API key doesn't match the one in your Memory API `.env` |
| `API ... ECONNREFUSED` | Memory API isn't running — run `docker compose up -d` |
| `fetch failed` / timeout | Check `BRAIN_API_URL` points to the correct host and port |
| Tool calls return empty results | Verify Qdrant is running and has data — use `brain_stats` to check |
| `Qdrant request timed out` | Qdrant is slow or unreachable — check connectivity, increase `QDRANT_TIMEOUT_MS` |
| `brain_entities` returns empty | Entity graph requires SQLite or Postgres backend (not Baserow) |
| `name is required for get/memories` | Provide `name` parameter when using `action="get"` or `action="memories"` |

## Full Documentation

See the [main repository](https://github.com/ZenSystemAI/zengram) for the complete API reference, adapter docs (Bash CLI, n8n, OpenClaw), deployment guide, and architecture overview.

## License

MIT
