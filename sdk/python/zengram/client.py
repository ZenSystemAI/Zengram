"""Core HTTP client for Zengram API."""

from __future__ import annotations

import time
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from .models import (
    Briefing,
    Entity,
    Graph,
    SearchResponse,
    Stats,
    StoreResult,
)

DEFAULT_TIMEOUT = 15.0
CONSOLIDATION_TIMEOUT = 120.0
MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 1.0
RETRYABLE_STATUS_CODES = {429, 502, 503, 504}


class BrainError(Exception):
    """Base exception for Brain API errors."""

    def __init__(self, message: str, status_code: Optional[int] = None, response_body: Optional[str] = None):
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


class RateLimitError(BrainError):
    """Raised when the API returns 429 Too Many Requests."""

    def __init__(self, message: str, retry_after: Optional[int] = None, **kwargs: Any):
        super().__init__(message, status_code=429, **kwargs)
        self.retry_after = retry_after


class BrainClient:
    """Synchronous client for the Zengram API.

    Usage::

        from zengram import BrainClient

        brain = BrainClient(url="http://localhost:8084", api_key="your-key")
        brain.store(type="fact", content="The sky is blue", source_agent="my-agent", key="sky-color")
        results = brain.search("sky color")
    """

    def __init__(
        self,
        url: str = "http://localhost:8084",
        api_key: str = "",
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = MAX_RETRIES,
        source_agent: Optional[str] = None,
    ):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self.default_source_agent = source_agent
        self._client = httpx.Client(
            base_url=self.url,
            headers={"x-api-key": api_key, "Content-Type": "application/json"},
            timeout=timeout,
        )

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> BrainClient:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[dict[str, Any]] = None,
        params: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Make an HTTP request with retry logic."""
        # Strip None values from params
        if params:
            params = {k: v for k, v in params.items() if v is not None}

        last_error: Optional[Exception] = None
        for attempt in range(self.max_retries + 1):
            try:
                response = self._client.request(
                    method,
                    path,
                    json=json,
                    params=params,
                    timeout=timeout or self.timeout,
                )

                if response.status_code == 429:
                    retry_after = int(response.headers.get("Retry-After", "5"))
                    if attempt < self.max_retries:
                        time.sleep(retry_after)
                        continue
                    raise RateLimitError(
                        f"Rate limit exceeded: {response.text}",
                        retry_after=retry_after,
                        response_body=response.text,
                    )

                if response.status_code in RETRYABLE_STATUS_CODES and attempt < self.max_retries:
                    time.sleep(RETRY_BACKOFF_BASE * (2 ** attempt))
                    continue

                if response.status_code >= 400:
                    raise BrainError(
                        f"API error {response.status_code}: {response.text}",
                        status_code=response.status_code,
                        response_body=response.text,
                    )

                return response.json()

            except httpx.TimeoutException as e:
                last_error = e
                if attempt < self.max_retries:
                    time.sleep(RETRY_BACKOFF_BASE * (2 ** attempt))
                    continue
                raise BrainError(f"Request timed out after {timeout or self.timeout}s: {method} {path}") from e

            except httpx.ConnectError as e:
                last_error = e
                if attempt < self.max_retries:
                    time.sleep(RETRY_BACKOFF_BASE * (2 ** attempt))
                    continue
                raise BrainError(f"Connection failed: {self.url}{path}") from e

        raise BrainError(f"Request failed after {self.max_retries + 1} attempts") from last_error

    # --- Store ---

    def store(
        self,
        type: str,
        content: str,
        source_agent: Optional[str] = None,
        client_id: Optional[str] = None,
        category: Optional[str] = None,
        importance: Optional[str] = None,
        key: Optional[str] = None,
        subject: Optional[str] = None,
        status_value: Optional[str] = None,
        knowledge_category: Optional[str] = None,
        valid_from: Optional[str] = None,
        valid_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> StoreResult:
        """Store a memory in the Shared Brain.

        Args:
            type: Memory type — "event", "fact", "decision", or "status".
            content: The memory content text.
            source_agent: Agent identifier. Falls back to client default.
            client_id: Project/client slug or "global".
            category: "semantic", "episodic", or "procedural".
            importance: "critical", "high", "medium", or "low".
            key: For facts — unique key for upsert/supersede.
            subject: For statuses — what system this status is about.
            status_value: For statuses — the current status value.
            knowledge_category: Domain category for the memory.
            valid_from: ISO 8601 — when this fact became true.
            valid_to: ISO 8601 — when this fact stopped being true.
            metadata: Arbitrary metadata dict.

        Returns:
            StoreResult with id, dedup status, and supersedes info.
        """
        agent = source_agent or self.default_source_agent
        if not agent:
            raise ValueError("source_agent is required (pass it here or set default_source_agent on client)")

        body: dict[str, Any] = {
            "type": type,
            "content": content,
            "source_agent": agent,
        }
        if client_id is not None:
            body["client_id"] = client_id
        if category is not None:
            body["category"] = category
        if importance is not None:
            body["importance"] = importance
        if key is not None:
            body["key"] = key
        if subject is not None:
            body["subject"] = subject
        if status_value is not None:
            body["status_value"] = status_value
        if knowledge_category is not None:
            body["knowledge_category"] = knowledge_category
        if valid_from is not None:
            body["valid_from"] = valid_from
        if valid_to is not None:
            body["valid_to"] = valid_to
        if metadata is not None:
            body["metadata"] = metadata

        data = self._request("POST", "/memory", json=body)
        return StoreResult.from_dict(data)

    # --- Search ---

    def search(
        self,
        query: str,
        *,
        type: Optional[str] = None,
        source_agent: Optional[str] = None,
        client_id: Optional[str] = None,
        category: Optional[str] = None,
        limit: Optional[int] = None,
        format: Optional[str] = None,
        include_superseded: Optional[bool] = None,
        knowledge_category: Optional[str] = None,
        at_time: Optional[str] = None,
        entity: Optional[str] = None,
    ) -> SearchResponse:
        """Multi-path search across all shared memories.

        Uses vector (semantic), keyword (BM25), and graph (entity BFS) retrieval
        in parallel, merged with Reciprocal Rank Fusion.

        Args:
            query: Natural language search query.
            type: Filter by memory type.
            source_agent: Filter by agent.
            client_id: Filter by client.
            category: Filter by category.
            limit: Max results (default 10, max 100).
            format: "compact" (default) or "full".
            include_superseded: Include superseded memories.
            knowledge_category: Filter by knowledge domain.
            at_time: ISO 8601 — return only memories valid at this time.
            entity: Filter by entity name.

        Returns:
            SearchResponse with scored results.
        """
        params: dict[str, Any] = {"q": query}
        if type is not None:
            params["type"] = type
        if source_agent is not None:
            params["source_agent"] = source_agent
        if client_id is not None:
            params["client_id"] = client_id
        if category is not None:
            params["category"] = category
        if limit is not None:
            params["limit"] = str(limit)
        if format is not None:
            params["format"] = format
        if include_superseded:
            params["include_superseded"] = "true"
        if knowledge_category is not None:
            params["knowledge_category"] = knowledge_category
        if at_time is not None:
            params["at_time"] = at_time
        if entity is not None:
            params["entity"] = entity

        data = self._request("GET", "/memory/search", params=params)
        return SearchResponse.from_dict(data)

    # --- Query (structured) ---

    def query(
        self,
        type: str,
        *,
        source_agent: Optional[str] = None,
        category: Optional[str] = None,
        client_id: Optional[str] = None,
        since: Optional[str] = None,
        key: Optional[str] = None,
        subject: Optional[str] = None,
    ) -> dict[str, Any]:
        """Structured query via database — facts by key, statuses by subject, events by time.

        Args:
            type: "events", "facts", or "statuses".
            source_agent: Filter by agent.
            category: Filter by category.
            client_id: Filter by client.
            since: For events — ISO 8601 timestamp.
            key: For facts — search by key.
            subject: For statuses — search by subject.

        Returns:
            Raw response dict with type, count, and results.
        """
        params: dict[str, Any] = {"type": type}
        if source_agent is not None:
            params["source_agent"] = source_agent
        if category is not None:
            params["category"] = category
        if client_id is not None:
            params["client_id"] = client_id
        if since is not None:
            params["since"] = since
        if key is not None:
            params["key"] = key
        if subject is not None:
            params["subject"] = subject

        return self._request("GET", "/memory/query", params=params)

    # --- Briefing ---

    def briefing(
        self,
        since: str,
        *,
        agent: Optional[str] = None,
        include: Optional[str] = None,
        format: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Briefing:
        """Get a session briefing — what happened since a given time.

        Args:
            since: ISO 8601 timestamp.
            agent: Requesting agent (entries from this agent excluded).
            include: Set to "all" to include own entries.
            format: "compact" (default), "summary", or "full".
            limit: Max memories to retrieve (default 100, max 500).

        Returns:
            Briefing with summary and categorized entries.
        """
        params: dict[str, Any] = {"since": since}
        if agent is not None:
            params["agent"] = agent
        if include is not None:
            params["include"] = include
        if format is not None:
            params["format"] = format
        if limit is not None:
            params["limit"] = str(limit)

        data = self._request("GET", "/briefing", params=params)
        return Briefing.from_dict(data)

    # --- Stats ---

    def stats(self) -> Stats:
        """Get memory health stats."""
        data = self._request("GET", "/stats")
        return Stats.from_dict(data)

    # --- Entities ---

    def entities(
        self,
        action: str = "list",
        *,
        name: Optional[str] = None,
        type: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> dict[str, Any]:
        """Query the entity graph.

        Args:
            action: "list", "get", "memories", or "stats".
            name: Entity name (required for get/memories).
            type: Filter by entity type (for list).
            limit: Max results.

        Returns:
            Raw response dict.
        """
        if action == "stats":
            return self._request("GET", "/entities/stats")
        elif action == "get":
            if not name:
                raise ValueError("name is required for action='get'")
            return self._request("GET", f"/entities/{name}")
        elif action == "memories":
            if not name:
                raise ValueError("name is required for action='memories'")
            params: dict[str, Any] = {}
            if limit is not None:
                params["limit"] = str(limit)
            return self._request("GET", f"/entities/{name}/memories", params=params)
        else:
            params = {}
            if type is not None:
                params["type"] = type
            if limit is not None:
                params["limit"] = str(limit)
            return self._request("GET", "/entities", params=params)

    # --- Graph ---

    def graph(
        self,
        entity: str,
        *,
        depth: Optional[int] = None,
        min_strength: Optional[int] = None,
    ) -> Graph:
        """Explore entity relationships in the knowledge graph.

        Args:
            entity: Entity name to explore.
            depth: Traversal depth (default 1, max 3).
            min_strength: Minimum relationship strength.

        Returns:
            Graph with nodes and edges.
        """
        params: dict[str, Any] = {}
        if depth is not None:
            params["depth"] = str(depth)
        if min_strength is not None:
            params["min_strength"] = str(min_strength)

        data = self._request("GET", f"/graph/{entity}", params=params)
        return Graph.from_dict(data)

    # --- Client ---

    def client(
        self,
        client: str,
        *,
        category: Optional[str] = None,
        query: Optional[str] = None,
        format: Optional[str] = None,
    ) -> dict[str, Any]:
        """Get everything known about a client.

        Args:
            client: Client ID or fuzzy name.
            category: Filter by knowledge category.
            query: Semantic search within client's memories.
            format: "compact" (default) or "full".

        Returns:
            Raw response dict with client memories organized by category.
        """
        params: dict[str, Any] = {}
        if category is not None:
            params["category"] = category
        if query is not None:
            params["query"] = query
        if format is not None:
            params["format"] = format

        return self._request("GET", f"/client/{client}", params=params)

    # --- Consolidation ---

    def consolidate(
        self,
        *,
        sync: bool = False,
    ) -> dict[str, Any]:
        """Trigger a memory consolidation run.

        Args:
            sync: If True, block until consolidation completes.

        Returns:
            Job info (async) or consolidation results (sync).
        """
        params: dict[str, Any] = {}
        if sync:
            params["sync"] = "true"
        return self._request(
            "POST", "/consolidate",
            params=params,
            timeout=CONSOLIDATION_TIMEOUT if sync else self.timeout,
        )

    def consolidation_status(self) -> dict[str, Any]:
        """Check consolidation status."""
        return self._request("GET", "/consolidate/status")

    def consolidation_job(self, job_id: str) -> dict[str, Any]:
        """Poll an async consolidation job."""
        return self._request("GET", f"/consolidate/job/{job_id}")

    # --- Export / Import ---

    def export(
        self,
        *,
        client_id: Optional[str] = None,
        type: Optional[str] = None,
        since: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> dict[str, Any]:
        """Export shared memories as JSON.

        Args:
            client_id: Filter by client.
            type: Filter by memory type.
            since: ISO 8601 — only memories after this time.
            limit: Max memories (default 500).

        Returns:
            Export response with memory payloads.
        """
        params: dict[str, Any] = {}
        if client_id is not None:
            params["client_id"] = client_id
        if type is not None:
            params["type"] = type
        if since is not None:
            params["since"] = since
        if limit is not None:
            params["limit"] = str(limit)

        return self._request("GET", "/export", params=params)

    def import_memories(self, data: list[dict[str, Any]]) -> dict[str, Any]:
        """Import memories from JSON.

        Args:
            data: Array of memory objects (same format as export output).

        Returns:
            Import results with counts.
        """
        return self._request("POST", "/export/import", json={"data": data})

    # --- Delete / Update ---

    def delete(self, memory_id: str, *, reason: Optional[str] = None) -> dict[str, Any]:
        """Soft-delete a memory (mark inactive).

        Args:
            memory_id: UUID of the memory.
            reason: Optional reason for deletion (logged).

        Returns:
            Deletion confirmation.
        """
        body: dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        return self._request("DELETE", f"/memory/{memory_id}", json=body)

    def update(
        self,
        memory_id: str,
        *,
        content: Optional[str] = None,
        importance: Optional[str] = None,
        knowledge_category: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Update an existing memory in place.

        Args:
            memory_id: UUID of the memory.
            content: New content (triggers re-embed).
            importance: New importance level.
            knowledge_category: New knowledge category.
            metadata: Updated metadata object.

        Returns:
            Update confirmation with affected fields.
        """
        body: dict[str, Any] = {}
        if content is not None:
            body["content"] = content
        if importance is not None:
            body["importance"] = importance
        if knowledge_category is not None:
            body["knowledge_category"] = knowledge_category
        if metadata is not None:
            body["metadata"] = metadata

        if not body:
            raise ValueError("Must provide at least one field to update")

        return self._request("PATCH", f"/memory/{memory_id}", json=body)

    # --- Reflect ---

    def reflect(
        self,
        topic: str,
        *,
        client_id: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> dict[str, Any]:
        """Reflect on a topic by synthesizing patterns across stored memories.

        Args:
            topic: Topic or question to reflect on.
            client_id: Scope reflection to a client.
            limit: Max memories to analyze (default 20, max 50).

        Returns:
            Reflection with patterns, timeline, contradictions, and gaps.
        """
        body: dict[str, Any] = {"topic": topic}
        if client_id is not None:
            body["client_id"] = client_id
        if limit is not None:
            body["limit"] = limit

        return self._request("POST", "/reflect", json=body, timeout=CONSOLIDATION_TIMEOUT)

    # --- Health ---

    def health(self) -> dict[str, Any]:
        """Check API health (no auth required)."""
        response = httpx.get(f"{self.url}/health", timeout=5.0)
        return response.json()


class AsyncBrainClient:
    """Async client for the Zengram API.

    Usage::

        from zengram import AsyncBrainClient

        async with AsyncBrainClient(url="http://localhost:8084", api_key="key") as brain:
            await brain.store(type="fact", content="...", source_agent="agent")
            results = await brain.search("query")
    """

    def __init__(
        self,
        url: str = "http://localhost:8084",
        api_key: str = "",
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = MAX_RETRIES,
        source_agent: Optional[str] = None,
    ):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self.default_source_agent = source_agent
        self._client = httpx.AsyncClient(
            base_url=self.url,
            headers={"x-api-key": api_key, "Content-Type": "application/json"},
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AsyncBrainClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[dict[str, Any]] = None,
        params: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Make an async HTTP request with retry logic."""
        import asyncio

        if params:
            params = {k: v for k, v in params.items() if v is not None}

        last_error: Optional[Exception] = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await self._client.request(
                    method,
                    path,
                    json=json,
                    params=params,
                    timeout=timeout or self.timeout,
                )

                if response.status_code == 429:
                    retry_after = int(response.headers.get("Retry-After", "5"))
                    if attempt < self.max_retries:
                        await asyncio.sleep(retry_after)
                        continue
                    raise RateLimitError(
                        f"Rate limit exceeded: {response.text}",
                        retry_after=retry_after,
                        response_body=response.text,
                    )

                if response.status_code in RETRYABLE_STATUS_CODES and attempt < self.max_retries:
                    await asyncio.sleep(RETRY_BACKOFF_BASE * (2 ** attempt))
                    continue

                if response.status_code >= 400:
                    raise BrainError(
                        f"API error {response.status_code}: {response.text}",
                        status_code=response.status_code,
                        response_body=response.text,
                    )

                return response.json()

            except httpx.TimeoutException as e:
                last_error = e
                if attempt < self.max_retries:
                    await asyncio.sleep(RETRY_BACKOFF_BASE * (2 ** attempt))
                    continue
                raise BrainError(f"Request timed out after {timeout or self.timeout}s: {method} {path}") from e

            except httpx.ConnectError as e:
                last_error = e
                if attempt < self.max_retries:
                    await asyncio.sleep(RETRY_BACKOFF_BASE * (2 ** attempt))
                    continue
                raise BrainError(f"Connection failed: {self.url}{path}") from e

        raise BrainError(f"Request failed after {self.max_retries + 1} attempts") from last_error

    # --- Delegated methods (same signatures as sync client) ---

    async def store(self, type: str, content: str, source_agent: Optional[str] = None, **kwargs: Any) -> StoreResult:
        agent = source_agent or self.default_source_agent
        if not agent:
            raise ValueError("source_agent is required")
        body: dict[str, Any] = {"type": type, "content": content, "source_agent": agent}
        body.update({k: v for k, v in kwargs.items() if v is not None})
        data = await self._request("POST", "/memory", json=body)
        return StoreResult.from_dict(data)

    async def search(self, query: str, **kwargs: Any) -> SearchResponse:
        params: dict[str, Any] = {"q": query}
        for k, v in kwargs.items():
            if v is not None:
                if k == "include_superseded" and v:
                    params[k] = "true"
                elif k == "limit":
                    params[k] = str(v)
                else:
                    params[k] = v
        data = await self._request("GET", "/memory/search", params=params)
        return SearchResponse.from_dict(data)

    async def query(self, type: str, **kwargs: Any) -> dict[str, Any]:
        params: dict[str, Any] = {"type": type}
        params.update({k: v for k, v in kwargs.items() if v is not None})
        return await self._request("GET", "/memory/query", params=params)

    async def briefing(self, since: str, **kwargs: Any) -> Briefing:
        params: dict[str, Any] = {"since": since}
        for k, v in kwargs.items():
            if v is not None:
                params[k] = str(v) if k == "limit" else v
        data = await self._request("GET", "/briefing", params=params)
        return Briefing.from_dict(data)

    async def stats(self) -> Stats:
        data = await self._request("GET", "/stats")
        return Stats.from_dict(data)

    async def entities(self, action: str = "list", **kwargs: Any) -> dict[str, Any]:
        name = kwargs.get("name")
        if action == "stats":
            return await self._request("GET", "/entities/stats")
        elif action == "get":
            return await self._request("GET", f"/entities/{name}")
        elif action == "memories":
            params = {"limit": str(kwargs["limit"])} if "limit" in kwargs else {}
            return await self._request("GET", f"/entities/{name}/memories", params=params)
        else:
            params = {k: v for k, v in kwargs.items() if k in ("type", "limit") and v is not None}
            if "limit" in params:
                params["limit"] = str(params["limit"])
            return await self._request("GET", "/entities", params=params)

    async def graph(self, entity: str, **kwargs: Any) -> Graph:
        params = {k: str(v) for k, v in kwargs.items() if v is not None}
        data = await self._request("GET", f"/graph/{entity}", params=params)
        return Graph.from_dict(data)

    async def client(self, client: str, **kwargs: Any) -> dict[str, Any]:
        params = {k: v for k, v in kwargs.items() if v is not None}
        return await self._request("GET", f"/client/{client}", params=params)

    async def consolidate(self, *, sync: bool = False) -> dict[str, Any]:
        params = {"sync": "true"} if sync else {}
        return await self._request(
            "POST", "/consolidate", params=params,
            timeout=CONSOLIDATION_TIMEOUT if sync else self.timeout,
        )

    async def consolidation_status(self) -> dict[str, Any]:
        return await self._request("GET", "/consolidate/status")

    async def consolidation_job(self, job_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/consolidate/job/{job_id}")

    async def export(self, **kwargs: Any) -> dict[str, Any]:
        params = {}
        for k, v in kwargs.items():
            if v is not None:
                params[k] = str(v) if k == "limit" else v
        return await self._request("GET", "/export", params=params)

    async def import_memories(self, data: list[dict[str, Any]]) -> dict[str, Any]:
        return await self._request("POST", "/export/import", json={"data": data})

    async def delete(self, memory_id: str, *, reason: Optional[str] = None) -> dict[str, Any]:
        body = {"reason": reason} if reason else {}
        return await self._request("DELETE", f"/memory/{memory_id}", json=body)

    async def update(self, memory_id: str, **kwargs: Any) -> dict[str, Any]:
        body = {k: v for k, v in kwargs.items() if v is not None}
        if not body:
            raise ValueError("Must provide at least one field to update")
        return await self._request("PATCH", f"/memory/{memory_id}", json=body)

    async def reflect(self, topic: str, **kwargs: Any) -> dict[str, Any]:
        body: dict[str, Any] = {"topic": topic}
        body.update({k: v for k, v in kwargs.items() if v is not None})
        return await self._request("POST", "/reflect", json=body, timeout=CONSOLIDATION_TIMEOUT)

    async def health(self) -> dict[str, Any]:
        async with httpx.AsyncClient() as c:
            response = await c.get(f"{self.url}/health", timeout=5.0)
            return response.json()
