#!/usr/bin/env bash
set -euo pipefail

# === Config ===
API_URL="${BRAIN_API_URL:-http://localhost:8084}"
SOURCE_AGENT="${BRAIN_AGENT_NAME:-my-agent}"

# Load API key from environment or .env file
if [ -z "${BRAIN_API_KEY:-}" ] && [ -f "${BRAIN_ENV_FILE:-$HOME/.config/zengram/.env}" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      BRAIN_API_KEY) export "$key=$value" ;;
    esac
  done < "${BRAIN_ENV_FILE:-$HOME/.config/zengram/.env}"
fi

if [ -z "${BRAIN_API_KEY:-}" ]; then
  echo "ERROR: BRAIN_API_KEY not set. Set it as env var or in ${BRAIN_ENV_FILE:-$HOME/.config/zengram/.env}" >&2
  exit 2
fi

AUTH_HEADER="X-Api-Key: ${BRAIN_API_KEY}"

# === Subcommand ===
if [ $# -lt 1 ]; then
  echo "Usage: brain.sh {store|search|briefing|query|stats|consolidate} [options]" >&2
  exit 1
fi

CMD="$1"
shift

# === Parse args ===
TYPE="" CONTENT="" CLIENT_ID="global" CATEGORY="" IMPORTANCE=""
QUERY="" LIMIT="" SINCE="" INCLUDE="" SOURCE="" KEY="" SUBJECT="" STATUS_VALUE="" FORMAT=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --type) TYPE="$2"; shift 2 ;;
    --content) CONTENT="$2"; shift 2 ;;
    --client_id) CLIENT_ID="$2"; shift 2 ;;
    --category) CATEGORY="$2"; shift 2 ;;
    --importance) IMPORTANCE="$2"; shift 2 ;;
    --query) QUERY="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --include) INCLUDE="$2"; shift 2 ;;
    --source_agent) SOURCE="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --subject) SUBJECT="$2"; shift 2 ;;
    --status_value) STATUS_VALUE="$2"; shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# === Commands ===

case "$CMD" in

  store)
    if [ -z "$TYPE" ] || [ -z "$CONTENT" ]; then
      echo "ERROR: --type and --content are required for store" >&2
      exit 1
    fi

    PAYLOAD=$(jq -n \
      --arg type "$TYPE" \
      --arg content "$CONTENT" \
      --arg source_agent "$SOURCE_AGENT" \
      --arg client_id "$CLIENT_ID" \
      --arg category "${CATEGORY:-episodic}" \
      --arg importance "${IMPORTANCE:-medium}" \
      --arg key "$KEY" \
      --arg subject "$SUBJECT" \
      --arg status_value "$STATUS_VALUE" \
      '{
        type: $type,
        content: $content,
        source_agent: $source_agent,
        client_id: $client_id,
        category: $category,
        importance: $importance
      }
      + (if $key != "" then {key: $key} else {} end)
      + (if $subject != "" then {subject: $subject} else {} end)
      + (if $status_value != "" then {status_value: $status_value} else {} end)')

    RESPONSE=$(curl -s --max-time 15 -X POST "${API_URL}/memory" \
      -H "Content-Type: application/json" \
      -H "${AUTH_HEADER}" \
      -d "$PAYLOAD")

    if echo "$RESPONSE" | jq -e '.id' > /dev/null 2>&1; then
      ID=$(echo "$RESPONSE" | jq -r '.id')
      HASH=$(echo "$RESPONSE" | jq -r '.content_hash')
      DEDUP=$(echo "$RESPONSE" | jq -r '.deduplicated')
      echo "Stored in Shared Brain (id: ${ID}, hash: ${HASH}, deduplicated: ${DEDUP})"
    else
      echo "ERROR: Store failed" >&2
      echo "$RESPONSE" | head -c 300 >&2
      exit 1
    fi
    ;;

  search)
    if [ -z "$QUERY" ]; then
      echo "ERROR: --query is required for search" >&2
      exit 1
    fi

    QS="q=$(jq -rn --arg q "$QUERY" '$q | @uri')&format=${FORMAT:-compact}"
    [ -n "$TYPE" ] && QS="${QS}&type=$(echo -n "$TYPE" | jq -sRr @uri)"
    [ -n "$SOURCE" ] && QS="${QS}&source_agent=$(echo -n "$SOURCE" | jq -sRr @uri)"
    [ -n "$CLIENT_ID" ] && [ "$CLIENT_ID" != "global" ] && QS="${QS}&client_id=$(echo -n "$CLIENT_ID" | jq -sRr @uri)"
    [ -n "$CATEGORY" ] && QS="${QS}&category=$(echo -n "$CATEGORY" | jq -sRr @uri)"
    [ -n "$LIMIT" ] && QS="${QS}&limit=${LIMIT}"

    RESPONSE=$(curl -s --max-time 15 -H "${AUTH_HEADER}" "${API_URL}/memory/search?${QS}")

    COUNT=$(echo "$RESPONSE" | jq -r '.count // 0')
    if [ "$COUNT" = "0" ]; then
      echo "No results found for: ${QUERY}"
      exit 0
    fi

    echo "[SHARED_BRAIN_START]"
    echo "Query: ${QUERY} — ${COUNT} results"
    echo ""
    echo "$RESPONSE" | jq -r '.results[] | "---\n[\(.source_agent)] [\(.type)] [\(.importance)] score:\(.effective_score) \(.created_at)\nClient: \(.client_id)\n\(.text)\n"'
    echo "[SHARED_BRAIN_END]"
    ;;

  briefing)
    if [ -z "$SINCE" ]; then
      echo "ERROR: --since is required for briefing" >&2
      exit 1
    fi

    QS="since=$(jq -rn --arg s "$SINCE" '$s | @uri')&agent=${SOURCE_AGENT}&format=${FORMAT:-compact}"
    [ -n "$INCLUDE" ] && QS="${QS}&include=${INCLUDE}"

    RESPONSE=$(curl -s --max-time 15 -H "${AUTH_HEADER}" "${API_URL}/briefing?${QS}")

    if ! echo "$RESPONSE" | jq -e '.summary' > /dev/null 2>&1; then
      echo "ERROR: Briefing request failed" >&2
      echo "$RESPONSE" | head -c 300 >&2
      exit 1
    fi

    TOTAL=$(echo "$RESPONSE" | jq -r '.summary.total_entries')
    EVENTS=$(echo "$RESPONSE" | jq -r '.summary.events')
    FACTS=$(echo "$RESPONSE" | jq -r '.summary.facts_updated')
    STATUSES=$(echo "$RESPONSE" | jq -r '.summary.status_changes')
    DECISIONS=$(echo "$RESPONSE" | jq -r '.summary.decisions')
    AGENTS=$(echo "$RESPONSE" | jq -r '.summary.agents_active | join(", ")')

    echo "[SHARED_BRAIN_BRIEFING]"
    echo "Since: ${SINCE}"
    echo "Total: ${TOTAL} entries — Events: ${EVENTS}, Facts: ${FACTS}, Status: ${STATUSES}, Decisions: ${DECISIONS}"
    echo "Agents active: ${AGENTS}"
    echo ""

    if [ "$EVENTS" != "0" ]; then
      echo "=== Events ==="
      echo "$RESPONSE" | jq -r '.events[] | "[\(.source_agent)] \(.created_at): \(.content)"'
      echo ""
    fi

    if [ "$FACTS" != "0" ]; then
      echo "=== Facts Updated ==="
      echo "$RESPONSE" | jq -r '.facts_updated[] | "[\(.source_agent)] \(.client_id): \(.content)"'
      echo ""
    fi

    if [ "$STATUSES" != "0" ]; then
      echo "=== Status Changes ==="
      echo "$RESPONSE" | jq -r '.status_changes[] | "[\(.source_agent)] \(.content)"'
      echo ""
    fi

    if [ "$DECISIONS" != "0" ]; then
      echo "=== Decisions ==="
      echo "$RESPONSE" | jq -r '.decisions[] | "[\(.source_agent)] \(.content)"'
      echo ""
    fi

    echo "[/SHARED_BRAIN_BRIEFING]"
    ;;

  query)
    QS=""
    [ -n "$TYPE" ] && QS="type=$(echo -n "$TYPE" | jq -sRr @uri)"
    [ -n "$SOURCE" ] && QS="${QS:+${QS}&}source_agent=$(echo -n "$SOURCE" | jq -sRr @uri)"
    [ -n "$CLIENT_ID" ] && [ "$CLIENT_ID" != "global" ] && QS="${QS:+${QS}&}client_id=$(echo -n "$CLIENT_ID" | jq -sRr @uri)"
    [ -n "$CATEGORY" ] && QS="${QS:+${QS}&}category=$(echo -n "$CATEGORY" | jq -sRr @uri)"
    [ -n "$SINCE" ] && QS="${QS:+${QS}&}since=$(jq -rn --arg s "$SINCE" '$s | @uri')"
    [ -n "$KEY" ] && QS="${QS:+${QS}&}key=$(echo -n "$KEY" | jq -sRr @uri)"
    [ -n "$SUBJECT" ] && QS="${QS:+${QS}&}subject=$(echo -n "$SUBJECT" | jq -sRr @uri)"

    RESPONSE=$(curl -s --max-time 15 -H "${AUTH_HEADER}" "${API_URL}/memory/query?${QS}")

    COUNT=$(echo "$RESPONSE" | jq -r '.count // 0')
    RTYPE=$(echo "$RESPONSE" | jq -r '.type // "unknown"')

    echo "[SHARED_BRAIN_QUERY]"
    echo "Type: ${RTYPE} — ${COUNT} results"
    echo ""

    if [ "$COUNT" != "0" ]; then
      echo "$RESPONSE" | jq -r '.results[] | "---\n\(. | to_entries | map("\(.key): \(.value)") | join("\n"))\n"'
    else
      echo "No results."
    fi

    echo "[/SHARED_BRAIN_QUERY]"
    ;;

  stats)
    RESPONSE=$(curl -s --max-time 15 -H "${AUTH_HEADER}" "${API_URL}/stats")
    echo "$RESPONSE" | jq .
    ;;

  consolidate)
    RESPONSE=$(curl -s --max-time 30 -X POST -H "${AUTH_HEADER}" "${API_URL}/consolidate")
    echo "$RESPONSE" | jq .
    ;;

  *)
    echo "Unknown command: $CMD" >&2
    echo "Usage: brain.sh {store|search|briefing|query|stats|consolidate} [options]" >&2
    exit 1
    ;;

esac
