#!/usr/bin/env bash
set -e

# =============================================================================
# Zengram — Multi-Agent Scenario
#
# Simulates three agents sharing memory through the same brain:
#
#   Agent 1: claude-code   — Development agent (stores facts + decisions)
#   Agent 2: n8n           — Automation agent (stores workflow events)
#   Agent 3: devops-agent  — Infrastructure agent (stores system statuses)
#
# Each agent stores memories, then later searches and gets briefings.
# The key insight: every agent can discover what the OTHERS have been doing,
# even though they run on different machines and never communicate directly.
#
# Prerequisites:
#   - The Memory API is running (docker compose up -d)
#   - curl and jq are installed
#
# Usage:
#   export BRAIN_API_KEY="your-key"
#   ./multi-agent-scenario.sh
# =============================================================================

API_URL="${BRAIN_API_URL:-http://localhost:8084}"
API_KEY="${BRAIN_API_KEY:-your-key-here}"

header_auth="X-Api-Key: ${API_KEY}"
header_json="Content-Type: application/json"

section() {
  echo ""
  echo "=================================================================="
  echo "  $1"
  echo "=================================================================="
  echo ""
}

store() {
  curl -s -X POST "${API_URL}/memory" \
    -H "${header_auth}" \
    -H "${header_json}" \
    -d "$1" | jq .
}

# ============================================================================
# ACT 1: Each agent does its work and stores memories
# ============================================================================

section "ACT 1 — Agents store memories independently"

# --- Agent 1: claude-code ---
# Claude Code is working on the API. It discovers an important architectural
# fact and makes a decision about the database schema.

echo ">> claude-code: Storing a fact about the API architecture..."
store '{
  "type": "fact",
  "content": "The user service API uses JWT tokens with RS256 signing. Public key is at /well-known/jwks.json. Tokens expire after 1 hour.",
  "source_agent": "claude-code",
  "client_id": "acme-corp",
  "category": "semantic",
  "importance": "high",
  "key": "acme-auth-config"
}'

echo ""
echo ">> claude-code: Recording a decision about the schema migration..."
store '{
  "type": "decision",
  "content": "Chose to add a composite index on (tenant_id, created_at) instead of separate indexes. Benchmarks show 3x improvement for the most common query pattern (list recent items per tenant). Trade-off: slightly slower inserts.",
  "source_agent": "claude-code",
  "client_id": "acme-corp",
  "category": "semantic",
  "importance": "high"
}'

# --- Agent 2: n8n ---
# An n8n automation workflow ran overnight. It processed client data and
# logged the result as an event.

echo ""
echo ">> n8n: Storing a workflow completion event..."
store '{
  "type": "event",
  "content": "Workflow daily-seo-report completed successfully. Generated SEO reports for 5 clients: acme-corp, globex, initech, umbrella, waystar. Total keywords tracked: 2,847. Reports emailed to stakeholders.",
  "source_agent": "n8n",
  "client_id": "global",
  "category": "episodic",
  "importance": "medium"
}'

echo ""
echo ">> n8n: Storing a failed workflow event..."
store '{
  "type": "event",
  "content": "Workflow lead-enrichment FAILED after 3 retries. Error: Clearbit API returned 429 (rate limited). 23 leads stuck in enrichment queue. Manual intervention needed.",
  "source_agent": "n8n",
  "client_id": "global",
  "category": "episodic",
  "importance": "critical"
}'

# --- Agent 3: devops-agent ---
# The devops agent monitors infrastructure and posts status updates.

echo ""
echo ">> devops-agent: Storing infrastructure status..."
store '{
  "type": "status",
  "content": "Production cluster healthy — 3/3 nodes running, avg CPU 34%, memory 61%. SSL cert expires in 47 days.",
  "source_agent": "devops-agent",
  "client_id": "global",
  "subject": "prod-cluster",
  "status_value": "healthy",
  "importance": "medium"
}'

echo ""
echo ">> devops-agent: Storing a migration status..."
store '{
  "type": "status",
  "content": "Database migration from PostgreSQL 15 to 16 is in progress. Logical replication lag: 12 seconds. Estimated completion: 2 hours.",
  "source_agent": "devops-agent",
  "client_id": "global",
  "subject": "pg16-migration",
  "status_value": "in-progress",
  "importance": "high"
}'

# ============================================================================
# ACT 2: Agents search — discovering each other's knowledge
# ============================================================================

section "ACT 2 — Agents discover each other's memories"

# Claude Code wants to understand the infrastructure before making code changes.
# It searches for "database" and finds BOTH its own schema decision AND the
# devops agent's migration status — knowledge it wouldn't have otherwise.

echo ">> claude-code searches for 'database migration'..."
echo "   (Finds devops-agent's migration status + its own schema decision)"
echo ""
curl -s "${API_URL}/memory/search?q=database+migration&limit=5" \
  -H "${header_auth}" | jq '.results[] | {source_agent, type, content: .text[0:100], effective_score}'

echo ""
echo ""

# n8n wants to check if there are any authentication changes that might
# affect its API integrations. It discovers claude-code's JWT fact.

echo ">> n8n searches for 'authentication tokens API'..."
echo "   (Finds claude-code's JWT architecture fact)"
echo ""
curl -s "${API_URL}/memory/search?q=authentication+tokens+API&client_id=acme-corp&limit=3" \
  -H "${header_auth}" | jq '.results[] | {source_agent, type, content: .text[0:100], effective_score}'

echo ""
echo ""

# The devops agent checks for any recent failures across the system.

echo ">> devops-agent searches for 'failed error'..."
echo "   (Finds n8n's failed workflow event)"
echo ""
curl -s "${API_URL}/memory/search?q=failed+error+retry&limit=3" \
  -H "${header_auth}" | jq '.results[] | {source_agent, type, content: .text[0:100], effective_score}'

# ============================================================================
# ACT 3: Session briefings — each agent catches up
# ============================================================================

section "ACT 3 — Agents get briefings (what did OTHERS do?)"

# Each agent asks for a briefing. The API automatically excludes the
# requesting agent's own entries so they only see what's new from others.

SINCE=$(date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
     || date -u -v-1H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
     || echo "2026-03-10T00:00:00Z")

echo ">> claude-code's briefing (sees n8n + devops-agent entries)..."
echo ""
curl -s "${API_URL}/briefing?since=${SINCE}&agent=claude-code" \
  -H "${header_auth}" | jq '{
    summary,
    events: [.events[] | {source: .source_agent, content: .content[0:80]}],
    statuses: [.status_changes[] | {source: .source_agent, content: .content[0:80]}]
  }'

echo ""
echo ""
echo ">> n8n's briefing (sees claude-code + devops-agent entries)..."
echo ""
curl -s "${API_URL}/briefing?since=${SINCE}&agent=n8n" \
  -H "${header_auth}" | jq '{
    summary,
    facts: [.facts_updated[] | {source: .source_agent, content: .content[0:80]}],
    decisions: [.decisions[] | {source: .source_agent, content: .content[0:80]}]
  }'

echo ""
echo ""
echo ">> devops-agent's briefing (sees claude-code + n8n entries)..."
echo ""
curl -s "${API_URL}/briefing?since=${SINCE}&agent=devops-agent" \
  -H "${header_auth}" | jq '{
    summary,
    events: [.events[] | {source: .source_agent, content: .content[0:80]}],
    decisions: [.decisions[] | {source: .source_agent, content: .content[0:80]}]
  }'

# ============================================================================
# Epilogue: Stats
# ============================================================================

section "Epilogue — Brain Stats"

echo ">> Total memory state after all three agents contributed:"
echo ""
curl -s "${API_URL}/stats" \
  -H "${header_auth}" | jq .

echo ""
echo "============================================================"
echo "  Scenario complete."
echo ""
echo "  Three agents, each doing their own work, each benefiting"
echo "  from the others' knowledge — without ever talking directly."
echo "  That's the point of a shared brain."
echo "============================================================"
