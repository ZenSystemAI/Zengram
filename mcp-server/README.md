# @zensystemai/zengram-mcp

MCP server for [Zengram](https://github.com/ZenSystemAI/Zengram) — gives Claude Code, Cursor, and other MCP-compatible AI tools access to a shared memory system that works across agents and machines.

## Prerequisites

This package connects to the Zengram API. You need to run that first:

```bash
git clone https://github.com/ZenSystemAI/Zengram.git
cd Zengram
cp .env.example .env  # Set BRAIN_API_KEY, GEMINI_API_KEY, POSTGRES_URL (and POSTGRES_PASSWORD)
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

### Without a global install (`npx`)

Skip `npm install -g` and let the MCP client fetch the package on demand:

```json
{
  "mcpServers": {
    "zengram": {
      "command": "npx",
      "args": ["-y", "@zensystemai/zengram-mcp"],
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
| `BRAIN_MCP_SOURCE_AGENT` | No | Default `source_agent` stamped on `brain_store` writes. Default: `claude-code`. Set this per agent in multi-agent fleets so writes are correctly attributed — cross-agent corroboration and briefings depend on it. |
| `BRAIN_MCP_TIMEOUT` | No | Timeout (ms) for standard API calls. Default: `15000`. |
| `BRAIN_MCP_CONSOLIDATION_TIMEOUT` | No | Timeout (ms) for long-running calls (consolidation, reflect, research). Default: `120000`. |

## Tools

| Tool | Description |
|------|-------------|
| `brain_store` | Store a memory (event, fact, decision, or status). Entities are automatically extracted. |
| `brain_search` | Multi-path search (vector + full-text, fused with RRF) across all memories. |
| `brain_briefing` | Session briefing — what happened since a given time. |
| `brain_query` | Structured query by type, key, subject, or time range. |
| `brain_stats` | Memory health stats (totals, active, decayed/superseded, by type). |
| `brain_consolidate` | Trigger or check LLM consolidation (also extracts and normalizes entities). |
| `brain_entities` | Query the entity graph — list, get details, find linked memories, stats. |
| `brain_update` | Update a memory in place (content, importance, knowledge_category, metadata) by `memory_id`. |
| `brain_delete` | Soft-delete a memory by `memory_id`. |
| `brain_export` | Export matching memories as JSON. |
| `brain_import` | Operator-approved bulk import of memories. |
| `brain_reflect` | On-demand LLM synthesis (patterns, timeline, contradictions, gaps) on a topic. |
| `brain_research` | Agentic iterate-until-sufficient retrieval + grounded synthesis on a topic (server-side opt-in via `RESEARCH_ENABLED`). |

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

### Search memories

```
brain_search query="deployment issues" limit=5
```

Multi-path search (vector similarity + full-text keyword, fused with RRF) across all memories. To scope results to a single entity, use `brain_entities action="memories"` (below).

The `format` parameter controls response verbosity: `compact` (default, content truncated to 200 chars), `full` (complete content + `retrieval_sources`), and `index` (minimal tokens — ID + 80-char summary + score + type only). Use `index` for progressive disclosure: run a cheap `index` scan first, then fetch the full content of only the memories you need in a second `full` call.

```
brain_search query="deployment issues" format="index" limit=20
```

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
| Tool calls return empty results | Verify the API and its Postgres container are running and have data — use `brain_stats` to check |
| `API request timed out` | The API or Postgres is slow or unreachable — check connectivity and the `BRAIN_MCP_TIMEOUT` setting |
| `brain_entities` returns empty | The entity store requires the Postgres structured backend (`STRUCTURED_STORE=postgres`) and extracted entities to exist |
| `name is required for get/memories` | Provide `name` parameter when using `action="get"` or `action="memories"` |

## Full Documentation

See the [main repository](https://github.com/ZenSystemAI/Zengram) for the complete API reference, adapter docs (Bash CLI, Claude Code session-end skill), deployment guide, and architecture overview.

## License

MIT
