#!/usr/bin/env bash
set -e

# =============================================================================
# Zengram — Full API Demo (curl + jq)
#
# Walks through every endpoint in the Memory API:
#   1. Store memories (event, fact, status, decision)
#   2. Semantic search
#   3. Session briefing
#   4. Structured query
#   5. Stats dashboard
#
# Prerequisites:
#   - The Memory API is running (docker compose up -d)
#   - curl and jq are installed
#
# Usage:
#   export BRAIN_API_KEY="your-key"   # or edit the default below
#   ./curl-demo.sh
# =============================================================================

API_URL="${BRAIN_API_URL:-http://localhost:8084}"
API_KEY="${BRAIN_API_KEY:-your-key-here}"

header_auth="X-Api-Key: ${API_KEY}"
header_json="Content-Type: application/json"

# Helper: print a section header
section() {
  echo ""
  echo "=================================================================="
  echo "  $1"
  echo "=================================================================="
  echo ""
}

# ---------------------------------------------------------------------------
# 0. Health check (no auth required)
# ---------------------------------------------------------------------------
section "Health Check"

curl -s "${API_URL}/health" | jq .

# ---------------------------------------------------------------------------
# 1. Store an EVENT — immutable historical record
# ---------------------------------------------------------------------------
section "Store: Event (append-only)"

# Events are immutable log entries. Great for tracking workflow runs,
# deployments, errors — anything that happened at a point in time.
curl -s -X POST "${API_URL}/memory" \
  -H "${header_auth}" \
  -H "${header_json}" \
  -d '{
    "type": "event",
    "content": "Deployed v2.4.1 to production — zero-downtime rolling update completed in 47 seconds",
    "source_agent": "demo-agent",
    "client_id": "acme-corp",
    "category": "episodic",
    "importance": "high"
  }' | jq .

# ---------------------------------------------------------------------------
# 2. Store a FACT with key — upserts by key (new value supersedes old)
# ---------------------------------------------------------------------------
section "Store: Fact with key (upsert)"

# Facts use key-based upsert. If a fact with the same key already exists,
# the old one is marked inactive and the new one links back to it.
curl -s -X POST "${API_URL}/memory" \
  -H "${header_auth}" \
  -H "${header_json}" \
  -d '{
    "type": "fact",
    "content": "Production database is PostgreSQL 16 on db-prod-1.internal:5432",
    "source_agent": "demo-agent",
    "client_id": "acme-corp",
    "category": "semantic",
    "importance": "high",
    "key": "acme-prod-db-host"
  }' | jq .

# ---------------------------------------------------------------------------
# 3. Store a STATUS with subject — latest value wins
# ---------------------------------------------------------------------------
section "Store: Status with subject (update-in-place)"

# Statuses track the current state of a system or process.
# Like facts, they upsert by subject — only the latest matters.
curl -s -X POST "${API_URL}/memory" \
  -H "${header_auth}" \
  -H "${header_json}" \
  -d '{
    "type": "status",
    "content": "CI/CD pipeline is green — all 248 tests passing",
    "source_agent": "demo-agent",
    "client_id": "acme-corp",
    "subject": "ci-pipeline",
    "status_value": "passing",
    "importance": "medium"
  }' | jq .

# ---------------------------------------------------------------------------
# 4. Store a DECISION — append-only record of a choice + reasoning
# ---------------------------------------------------------------------------
section "Store: Decision (append-only)"

# Decisions capture the reasoning behind a choice. They never get overwritten
# because understanding *why* something was decided is always valuable.
curl -s -X POST "${API_URL}/memory" \
  -H "${header_auth}" \
  -H "${header_json}" \
  -d '{
    "type": "decision",
    "content": "Chose PostgreSQL over MySQL for the new service because we need JSONB support and row-level security. MySQL was considered but lacks native JSON indexing.",
    "source_agent": "demo-agent",
    "client_id": "acme-corp",
    "category": "semantic",
    "importance": "high"
  }' | jq .

# ---------------------------------------------------------------------------
# 5. Semantic search — find memories by meaning, not exact text
# ---------------------------------------------------------------------------
section "Search: Semantic (vector similarity)"

# Search queries are embedded and compared against stored memories.
# Results are ranked by similarity * confidence (confidence decays over time).
curl -s "${API_URL}/memory/search?q=database+setup&client_id=acme-corp&limit=5" \
  -H "${header_auth}" | jq .

# ---------------------------------------------------------------------------
# 6. Session briefing — what happened since a given timestamp
# ---------------------------------------------------------------------------
section "Briefing: What happened since yesterday?"

# The briefing endpoint returns categorized updates from all agents.
# It excludes the requesting agent's own entries (they already know).
SINCE=$(date -u -d '1 day ago' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
     || date -u -v-1d '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
     || echo "2026-03-09T00:00:00Z")

curl -s "${API_URL}/briefing?since=${SINCE}&agent=another-agent" \
  -H "${header_auth}" | jq .

# ---------------------------------------------------------------------------
# 7. Structured query — look up facts by key
# ---------------------------------------------------------------------------
section "Query: Fact by key (structured lookup)"

# Structured queries hit the database (SQLite/Postgres/Baserow), not Qdrant.
# Useful for exact lookups: "give me the fact with key X".
curl -s "${API_URL}/memory/query?type=facts&key=acme-prod-db-host" \
  -H "${header_auth}" | jq .

# ---------------------------------------------------------------------------
# 8. Structured query — list all current statuses
# ---------------------------------------------------------------------------
section "Query: All statuses"

curl -s "${API_URL}/memory/query?type=statuses" \
  -H "${header_auth}" | jq .

# ---------------------------------------------------------------------------
# 9. Stats — memory health dashboard
# ---------------------------------------------------------------------------
section "Stats: Memory Health"

# Stats show totals by type, by agent, decay info, and more.
curl -s "${API_URL}/stats" \
  -H "${header_auth}" | jq .

# ---------------------------------------------------------------------------
# 10. Entity listing — browse the knowledge graph
# ---------------------------------------------------------------------------
section "Entities: List (filtered by type)"

# List all technology entities. Also supports: client, person, domain,
# workflow, agent, system, service.
curl -s "${API_URL}/entities?type=technology&limit=10" \
  -H "${header_auth}" | jq .

# ---------------------------------------------------------------------------
# 11. Entity detail — single entity by name or alias
# ---------------------------------------------------------------------------
section "Entity: Detail (by name)"

# Get a single entity including its alias list and metadata.
# Alias resolution means "acme", "Acme Corp", "acme-corp" all work.
curl -s "${API_URL}/entities/acme-corp" \
  -H "${header_auth}" | jq .

# ---------------------------------------------------------------------------
# 12. Client briefing — everything known about a client
# ---------------------------------------------------------------------------
section "Client: Briefing"

# Returns all memories for a client grouped by knowledge_category:
# brand, strategy, meeting, content, technical, relationship, general.
# Supports fuzzy name resolution.
curl -s "${API_URL}/client/acme-corp" \
  -H "${header_auth}" | jq .

# ---------------------------------------------------------------------------
# 13. Entity relationship graph — graph data as JSON
# ---------------------------------------------------------------------------
section "Graph: Entity Relationships (JSON)"

# Get entity relationships as a node/edge graph centered on an entity.
# Use format=html (or visit /graph in a browser) for interactive D3.js viz.
curl -s "${API_URL}/graph?format=json&entity=acme-corp&depth=2" \
  -H "${header_auth}" | jq .

# ---------------------------------------------------------------------------
# 14. Export — backup all memories as JSON
# ---------------------------------------------------------------------------
section "Export: Backup memories"

# Exports all active memories. Useful before embedding provider migration.
# Supports ?client_id= and ?type= filters.
curl -s "${API_URL}/export?client_id=acme-corp" \
  -H "${header_auth}" | jq '.memories | length'

echo "  (showing memory count only — pipe to a file for full backup)"

# ---------------------------------------------------------------------------
# 15. Import — restore from a previous export
# ---------------------------------------------------------------------------
section "Import: Restore memories"

# Imports memories from a previous export. Handles deduplication.
# In practice you would pipe a backup file: -d @backup.json
echo '  (skipping import demo — use: curl -X POST "${API_URL}/import" -d @backup.json)'

# ---------------------------------------------------------------------------
# 16. Delete — soft-delete a memory
# ---------------------------------------------------------------------------
section "Delete: Soft-delete a memory"

# Soft-deletes a memory (marks inactive). Agent-scoped keys can only
# delete their own memories. The reason field is optional but logged.
# Using a placeholder ID here — replace with a real ID from a store response.
echo '  (skipping delete demo — use: curl -X DELETE "${API_URL}/memory/YOUR-ID" -H "X-Api-Key: ..." -d '"'"'{"reason": "outdated"}'"'"')'

echo ""
echo "Done! All API endpoints demonstrated."
