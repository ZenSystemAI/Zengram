# Contributing to Zengram

Thanks for your interest in contributing! This project aims to be the best open-source cross-agent memory system, and contributions help make that happen.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/zengram.git`
3. Create a branch: `git checkout -b my-feature`
4. Make your changes
5. Push and open a pull request

## Prerequisites

- **Node.js 20+** (required -- the codebase uses modern ES module features)
- Docker (for Qdrant)
- An OpenAI or Gemini API key (or local Ollama for embeddings)

## Development Setup

```bash
# Start infrastructure
docker compose up -d qdrant

# Run the API in dev mode
cd api
npm install
npm run dev

# In another terminal — run the MCP server (optional)
cd mcp-server
npm install
npm start
```

Copy `.env.example` to `.env` and fill in your keys.

## Running Tests

```bash
cd api
npm test
```

Tests cover validation middleware, entity extraction, credential scrubbing, RRF fusion, webhook notifications, and client resolution. All tests must pass before submitting a PR.

## Project Structure

- **`api/`** — Express API server (the core)
- **`mcp-server/`** — MCP server for Claude Code / Cursor
- **`adapters/`** — Integration adapters (bash CLI, n8n workflow)

## What to Contribute

### Good first issues
- Add tests (we need more coverage)
- Improve error messages
- Documentation fixes and improvements

### Bigger contributions
- New storage backend (e.g., MySQL, MongoDB)
- New embedding provider (e.g., Cohere, local ONNX)
- New adapter (e.g., Python CLI, VS Code extension)
- Performance improvements to search/consolidation

### Before starting large changes
Open an issue first to discuss your approach. This avoids duplicate work and ensures alignment with the project direction.

## Code Style

- ES modules (`import`/`export`, not `require`)
- No TypeScript -- keeping the codebase accessible
- Minimal dependencies — don't add a package for something you can write in 20 lines
- Error messages should be helpful and include context

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Add/update tests if applicable
- Make sure existing functionality isn't broken

## Reporting Bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Node version, Docker version)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
