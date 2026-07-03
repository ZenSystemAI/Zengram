<p align="center">
  <img src=".github/logo.svg" alt="ZenSystem" width="120" />
  <h1 align="center">Zengram</h1>
  <p align="center">
    <strong>Shared memory for multi-agent AI systems.</strong>
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> &bull;
    <a href="#how-it-works">How It Works</a> &bull;
    <a href="#benchmarks">Benchmarks</a> &bull;
    <a href="#adapters">Adapters</a> &bull;
    <a href="docs/api-reference.md">API Docs</a> &bull;
    <a href="docs/configuration.md">Config</a>
  </p>
  <p align="center">
    <a href="https://github.com/ZenSystemAI/Zengram/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ZenSystemAI/Zengram/actions/workflows/ci.yml/badge.svg" /></a>
    <a href="https://www.npmjs.com/package/@zensystemai/zengram-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@zensystemai/zengram-mcp.svg" /></a>
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" />
    <img alt="Node 20+" src="https://img.shields.io/badge/node-20%2B-green.svg" />
    <img alt="Docker" src="https://img.shields.io/badge/docker-ready-blue.svg" />
    <img alt="MCP" src="https://img.shields.io/badge/MCP-compatible-purple.svg" />
    <a href="https://github.com/ZenSystemAI/Zengram/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/ZenSystemAI/Zengram?style=social" /></a>
  </p>
</p>

<p align="center">
  <img src=".github/hero.jpg" alt="Zengram — shared memory for multi-agent AI systems" width="700" />
</p>

Store a fact from Claude Code on your laptop, recall it from an autonomous agent on your server, get a briefing from another session — all through the same memory system. Born from a production setup where nothing existed that let multiple AI agents share memory across separate machines.

---

## The Problem

<p align="center">
  <img src=".github/shared memory.jpg" alt="Before and after shared memory" width="600" />
</p>

You run multiple AI agents — Claude Code for development, autonomous agents for tasks. They each maintain their own context and forget everything between sessions. When one agent discovers something important, the others never learn about it.

## How It Works

### Typed Memory

<p align="center">
  <img src=".github/4 memory type.jpg" alt="4 Memory Types" width="600" />
</p>

Events are immutable history. Facts upsert by key — new facts supersede old ones. Statuses track current state. Decisions record choices and reasoning. Each type has its own lifecycle, decay rules, and mutation semantics.

### Unified Storage

<p align="center">
  <img src=".github/dual-database.jpg" alt="Single-Postgres Storage Design" width="600" />
</p>

Every memory lives in a single Postgres database: **pgvector** (HNSW) for semantic vector search and structured tables for queries, entities, and full-text search. Get both "find memories similar to X" and "give me all facts with key Y" from the same system — one container, no separate vector service.

### Multi-Path Search

Search runs two retrieval paths in parallel, fused with [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf):

1. **Vector search** — Cosine similarity via pgvector (HNSW, with iterative index scans on pgvector 0.8+ so tenant-scoped queries don't lose recall)
2. **Full-text search** — Postgres tsvector (`websearch_to_tsquery` + `ts_rank_cd`)

Final ranking blends the fused RRF signal with vector similarity, then weights confidence decay, access frequency (capped), temporal proximity, and importance — items found by both paths genuinely rank higher. **98.4% retrieval accuracy** on LongMemEval.

### Built for Multi-Agent

- **Cross-agent briefings** — "What happened since I was last here?" returns updates from all other agents
- **Cross-agent corroboration** — when a second agent independently stores the same fact, it's recorded as an observation (`observed_by`), not dropped as a duplicate
- **Credential scrubbing** — API keys, JWTs, passwords, cloud/service tokens automatically redacted before storage
- **Entity extraction** — Regex + alias cache at write time
- **LLM consolidation** — Periodic background process merges duplicates, resolves contradictions, discovers connections

## Benchmarks

<p align="center">
  <img src=".github/benchmark-chart.svg" alt="LongMemEval Benchmark Results" width="600" />
</p>

Evaluated on [LongMemEval](https://github.com/xiaowu0162/LongMemEval), the academic benchmark for long-term conversational memory:

| | Score |
|---|:---:|
| **Retrieval accuracy** (finding the right memories) | **98.4%** |
| **QA accuracy** (GPT-4o answering from retrieved context) | **76.0%** |
| Full-context GPT-4o (entire history in prompt, no retrieval) | 72.4% |

The benchmark uses **cosine similarity only** — none of the API's multi-path features (keyword full-text, temporal boost) were used. [Full methodology and per-category breakdown](docs/benchmarks.md).

> LongMemEval tests single-agent chat recall. Zengram is built for multi-agent coordination — features like cross-agent briefings, typed memory, entity extraction, and credential scrubbing aren't measured by this benchmark but are core to production use.

## How It Compares

| Feature | Zengram | [Mem0](https://github.com/mem0ai/mem0) | [Letta](https://github.com/letta-ai/letta) | [Zep](https://github.com/getzep/graphiti) | [Hindsight](https://github.com/cyanheads/hindsight-core) |
|---------|:-:|:-:|:-:|:-:|:-:|
| Cross-machine by design | **Yes** | Cloud only | No | Cloud only | No |
| Typed memory (event/fact/status/decision) | **Yes** | No | No | No | No |
| Multi-path search (vector+full-text) | **Yes** | Vector only | Vector only | Hybrid | **Yes** |
| Session briefings | **Yes** | No | No | No | No |
| Credential scrubbing | **Yes** | No | No | No | No |
| Entity extraction + linking | **Yes** | Graph (Pro) | No | **Yes** | No |
| LLM consolidation | **Yes** | Inline | Self-managed | No | Reflect |
| Temporal validity | **Yes** | No | No | **Yes** | No |
| MCP server included | **Yes** | Community | No | No | **Yes** |
| Self-hostable (fully open) | **Yes** | Community ed. | **Yes** | Graphiti only | **Yes** |

## Quick Start

```bash
git clone https://github.com/ZenSystemAI/Zengram.git
cd Zengram

cp .env.example .env
# Edit .env — set BRAIN_API_KEY and your embedding provider key

docker compose up -d

# Verify
curl http://localhost:8084/health

# Store your first memory
curl -X POST http://localhost:8084/memory \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: YOUR_KEY" \
  -d '{
    "type": "fact",
    "content": "The API uses port 8084 by default",
    "source_agent": "my-agent",
    "key": "api-default-port"
  }'
```

## Adapters

### MCP Server (Claude Code, Cursor, Windsurf)

13 tools: `brain_store`, `brain_search`, `brain_briefing`, `brain_query`, `brain_stats`, `brain_consolidate`, `brain_entities`, `brain_delete`, `brain_update`, `brain_export`, `brain_import`, `brain_reflect`, `brain_research`.

```json
{
  "mcpServers": {
    "zengram": {
      "command": "node",
      "args": ["/path/to/zengram/mcp-server/src/index.js"],
      "env": {
        "BRAIN_API_URL": "http://localhost:8084",
        "BRAIN_API_KEY": "your-key"
      }
    }
  }
}
```

Or install via npm: `npm install -g @zensystemai/zengram-mcp`

### Claude Code Skills

Copy [`adapters/claude-code/sessionend/`](adapters/claude-code/sessionend/) to your project's `.claude/skills/` to get the `/sessionend` ritual — structured session reflections stored directly to Zengram. [Full guide](adapters/claude-code/README.md).

### Bash CLI

- **Bash**: `./adapters/bash/brain.sh store --type fact --content "Server migrated"`
- **Any HTTP client**: Plain REST — [full reference](docs/api-reference.md)

## Documentation

| Doc | Description |
|-----|-------------|
| [API Reference](docs/api-reference.md) | Every endpoint with request/response examples |
| [Architecture](docs/architecture.md) | System design, data flows, component inventory |
| [Configuration](docs/configuration.md) | All environment variables |
| [Data Model](docs/data-model.md) | Memory types, decay, dedup, supersedes logic |
| [MCP Tools](docs/mcp-tools.md) | The 13 MCP tools agents use |
| [Operations](docs/operations.md) | Deployment, monitoring, failure modes |
| [Benchmarks](docs/benchmarks.md) | Full LongMemEval methodology and results |
| [Examples](examples/) | curl demo, Python client |

## Roadmap

**Recently shipped**: agentic iterate-until-sufficient retrieval (`brain_research`) with grounded `[mem:<id>]` citations, pgvector migration (single-Postgres storage), multi-collection support, on-demand LLM reflection, temporal validity, multi-path RRF search (vector + BM25) — [full changelog](CHANGELOG.md)

**Coming next**: Automatic memory capture, hosted docs, LangChain/LlamaIndex integration

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## See Also

- **[OpenClaw Memory Toolkit](https://github.com/ZenSystemAI/openclaw-memory)** — Long-term memory for OpenClaw agents.

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  Built by <a href="https://github.com/ZenSystemAI">ZenSystem AI</a>
</p>
