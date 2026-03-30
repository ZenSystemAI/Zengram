"""Tests for Zengram Python SDK."""

import pytest
import httpx
import respx
from zengram import (
    BrainClient,
    BrainError,
    RateLimitError,
    SearchResponse,
    StoreResult,
    Stats,
    Briefing,
    Graph,
)


API_URL = "http://localhost:8084"
API_KEY = "test-key"


@pytest.fixture
def brain():
    client = BrainClient(url=API_URL, api_key=API_KEY, source_agent="test-agent", max_retries=0)
    yield client
    client.close()


class TestHealth:
    @respx.mock
    def test_health(self, brain):
        respx.get(f"{API_URL}/health").mock(
            return_value=httpx.Response(200, json={"status": "ok", "service": "zengram"})
        )
        result = brain.health()
        assert result["status"] == "ok"


class TestStore:
    @respx.mock
    def test_store_fact(self, brain):
        respx.post(f"{API_URL}/memory").mock(
            return_value=httpx.Response(201, json={
                "id": "abc-123",
                "type": "fact",
                "content_hash": "deadbeef",
                "deduplicated": False,
                "supersedes": None,
            })
        )
        result = brain.store(type="fact", content="Test fact", key="test-key")
        assert isinstance(result, StoreResult)
        assert result.id == "abc-123"
        assert result.type == "fact"
        assert not result.deduplicated

    @respx.mock
    def test_store_dedup(self, brain):
        respx.post(f"{API_URL}/memory").mock(
            return_value=httpx.Response(200, json={
                "id": "abc-123",
                "type": "fact",
                "content_hash": "deadbeef",
                "deduplicated": True,
                "observed_by": ["agent-a", "test-agent"],
                "observation_count": 2,
            })
        )
        result = brain.store(type="fact", content="Duplicate")
        assert result.deduplicated
        assert result.observation_count == 2

    def test_store_requires_agent(self):
        client = BrainClient(url=API_URL, api_key=API_KEY, max_retries=0)
        with pytest.raises(ValueError, match="source_agent is required"):
            client.store(type="fact", content="test")
        client.close()

    @respx.mock
    def test_store_with_default_agent(self, brain):
        respx.post(f"{API_URL}/memory").mock(
            return_value=httpx.Response(201, json={
                "id": "x", "type": "event", "content_hash": "x", "deduplicated": False,
            })
        )
        result = brain.store(type="event", content="test")
        assert result.id == "x"
        # Verify the request used default source_agent
        request = respx.calls.last.request
        import json
        body = json.loads(request.content)
        assert body["source_agent"] == "test-agent"


class TestSearch:
    @respx.mock
    def test_search(self, brain):
        respx.get(f"{API_URL}/memory/search").mock(
            return_value=httpx.Response(200, json={
                "query": "test",
                "count": 1,
                "results": [{
                    "id": "r1",
                    "score": 0.85,
                    "effective_score": 0.83,
                    "type": "fact",
                    "text": "Test result",
                    "source_agent": "agent-a",
                    "client_id": "global",
                    "importance": "medium",
                    "created_at": "2026-03-28T00:00:00Z",
                }],
            })
        )
        result = brain.search("test")
        assert isinstance(result, SearchResponse)
        assert result.count == 1
        assert result.results[0].score == 0.85
        assert result.results[0].content == "Test result"

    @respx.mock
    def test_search_with_filters(self, brain):
        respx.get(f"{API_URL}/memory/search").mock(
            return_value=httpx.Response(200, json={"query": "q", "count": 0, "results": []})
        )
        result = brain.search("q", type="fact", client_id="acme", limit=5, format="full")
        assert result.count == 0
        # Verify params were passed
        request = respx.calls.last.request
        assert "type=fact" in str(request.url)
        assert "client_id=acme" in str(request.url)


class TestBriefing:
    @respx.mock
    def test_briefing(self, brain):
        respx.get(f"{API_URL}/briefing").mock(
            return_value=httpx.Response(200, json={
                "since": "2026-03-28T00:00:00Z",
                "format": "compact",
                "requesting_agent": "test-agent",
                "generated_at": "2026-03-29T12:00:00Z",
                "summary": {"total_entries": 5, "events": 3, "facts_updated": 2},
                "events": [{"id": "e1", "content": "Deploy completed", "source_agent": "n8n", "importance": "high", "created_at": "2026-03-28T10:00:00Z"}],
                "facts_updated": [],
                "status_changes": [],
                "decisions": [],
            })
        )
        result = brain.briefing(since="2026-03-28T00:00:00Z")
        assert isinstance(result, Briefing)
        assert result.summary["total_entries"] == 5
        assert len(result.events) == 1
        assert result.events[0].content == "Deploy completed"


class TestStats:
    @respx.mock
    def test_stats(self, brain):
        respx.get(f"{API_URL}/stats").mock(
            return_value=httpx.Response(200, json={
                "total_memories": 39329,
                "vectors_count": 39329,
                "active": 35000,
                "superseded": 4329,
                "consolidated": 1200,
                "decayed_below_50pct": 50,
                "by_type": {"event": 20000, "fact": 10000, "decision": 5000, "status": 4329},
            })
        )
        result = brain.stats()
        assert isinstance(result, Stats)
        assert result.total_memories == 39329
        assert result.by_type["event"] == 20000


class TestGraph:
    @respx.mock
    def test_graph(self, brain):
        respx.get(f"{API_URL}/graph/Docker").mock(
            return_value=httpx.Response(200, json={
                "center": "Docker",
                "nodes": [
                    {"id": "Docker", "type": "technology", "mention_count": 50},
                    {"id": "Qdrant", "type": "technology", "mention_count": 30},
                ],
                "edges": [
                    {"source": "Docker", "target": "Qdrant", "type": "co_occurrence", "strength": 15},
                ],
            })
        )
        result = brain.graph("Docker")
        assert isinstance(result, Graph)
        assert result.center == "Docker"
        assert len(result.nodes) == 2
        assert result.edges[0].strength == 15


class TestDeleteUpdate:
    @respx.mock
    def test_delete(self, brain):
        respx.delete(f"{API_URL}/memory/abc-123").mock(
            return_value=httpx.Response(200, json={"id": "abc-123", "deleted": True})
        )
        result = brain.delete("abc-123", reason="outdated")
        assert result["deleted"]

    @respx.mock
    def test_update(self, brain):
        respx.patch(f"{API_URL}/memory/abc-123").mock(
            return_value=httpx.Response(200, json={"id": "abc-123", "updated": True, "updated_fields": ["importance"]})
        )
        result = brain.update("abc-123", importance="critical")
        assert result["updated"]

    def test_update_requires_field(self, brain):
        with pytest.raises(ValueError, match="Must provide at least one field"):
            brain.update("abc-123")


class TestErrorHandling:
    @respx.mock
    def test_api_error(self, brain):
        respx.get(f"{API_URL}/stats").mock(
            return_value=httpx.Response(500, text="Internal server error")
        )
        with pytest.raises(BrainError) as exc_info:
            brain.stats()
        assert exc_info.value.status_code == 500

    @respx.mock
    def test_rate_limit(self, brain):
        respx.post(f"{API_URL}/memory").mock(
            return_value=httpx.Response(429, text="Rate limited", headers={"Retry-After": "10"})
        )
        with pytest.raises(RateLimitError) as exc_info:
            brain.store(type="fact", content="test")
        assert exc_info.value.retry_after == 10

    @respx.mock
    def test_auth_error(self, brain):
        respx.get(f"{API_URL}/stats").mock(
            return_value=httpx.Response(401, text="Invalid API key")
        )
        with pytest.raises(BrainError) as exc_info:
            brain.stats()
        assert exc_info.value.status_code == 401


class TestRetry:
    @respx.mock
    def test_retry_on_503(self):
        client = BrainClient(url=API_URL, api_key=API_KEY, max_retries=2)
        route = respx.get(f"{API_URL}/stats")
        route.side_effect = [
            httpx.Response(503, text="Service unavailable"),
            httpx.Response(503, text="Service unavailable"),
            httpx.Response(200, json={"total_memories": 100, "vectors_count": 100, "active": 90}),
        ]
        result = client.stats()
        assert result.total_memories == 100
        assert route.call_count == 3
        client.close()
