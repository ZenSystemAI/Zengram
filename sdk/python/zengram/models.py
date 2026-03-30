"""Data models for Zengram SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class Memory:
    """A single memory from the Shared Brain."""
    id: str
    type: str
    content: str
    source_agent: str
    client_id: str = "global"
    category: str = "episodic"
    importance: str = "medium"
    knowledge_category: str = "general"
    confidence: float = 1.0
    access_count: int = 0
    active: bool = True
    created_at: str = ""
    last_accessed_at: str = ""
    content_hash: str = ""
    entities: list[dict[str, str]] = field(default_factory=list)
    observed_by: list[str] = field(default_factory=list)
    observation_count: int = 1
    supersedes: Optional[str] = None
    superseded_by: Optional[str] = None
    key: Optional[str] = None
    subject: Optional[str] = None
    status_value: Optional[str] = None
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Memory:
        """Create a Memory from an API response dict."""
        return cls(
            id=data.get("id", ""),
            type=data.get("type", ""),
            content=data.get("text", data.get("content", "")),
            source_agent=data.get("source_agent", ""),
            client_id=data.get("client_id", "global"),
            category=data.get("category", "episodic"),
            importance=data.get("importance", "medium"),
            knowledge_category=data.get("knowledge_category", "general"),
            confidence=data.get("confidence", 1.0),
            access_count=data.get("access_count", 0),
            active=data.get("active", True),
            created_at=data.get("created_at", ""),
            last_accessed_at=data.get("last_accessed_at", ""),
            content_hash=data.get("content_hash", ""),
            entities=data.get("entities", []),
            observed_by=data.get("observed_by", []),
            observation_count=data.get("observation_count", 1),
            supersedes=data.get("supersedes"),
            superseded_by=data.get("superseded_by"),
            key=data.get("key"),
            subject=data.get("subject"),
            status_value=data.get("status_value"),
            valid_from=data.get("valid_from"),
            valid_to=data.get("valid_to"),
            metadata=data.get("metadata"),
        )


@dataclass
class SearchResult:
    """A search result with scoring metadata."""
    id: str
    score: float
    effective_score: float
    type: str
    content: str
    source_agent: str
    client_id: str = "global"
    importance: str = "medium"
    created_at: str = ""
    confidence: float = 1.0
    retrieval_sources: Optional[list[str]] = None
    entities: list[dict[str, str]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SearchResult:
        return cls(
            id=data.get("id", ""),
            score=data.get("score", 0.0),
            effective_score=data.get("effective_score", 0.0),
            type=data.get("type", ""),
            content=data.get("text", data.get("content", "")),
            source_agent=data.get("source_agent", ""),
            client_id=data.get("client_id", "global"),
            importance=data.get("importance", "medium"),
            created_at=data.get("created_at", ""),
            confidence=data.get("confidence", 1.0),
            retrieval_sources=data.get("retrieval_sources"),
            entities=data.get("entities", []),
        )


@dataclass
class SearchResponse:
    """Response from a search query."""
    query: str
    count: int
    results: list[SearchResult]
    retrieval: Optional[dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SearchResponse:
        return cls(
            query=data.get("query", ""),
            count=data.get("count", 0),
            results=[SearchResult.from_dict(r) for r in data.get("results", [])],
            retrieval=data.get("retrieval"),
        )


@dataclass
class StoreResult:
    """Response from storing a memory."""
    id: str
    type: str
    content_hash: str
    deduplicated: bool = False
    corroborated: bool = False
    supersedes: Optional[str] = None
    observed_by: list[str] = field(default_factory=list)
    observation_count: int = 1
    warning: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> StoreResult:
        return cls(
            id=data.get("id", ""),
            type=data.get("type", ""),
            content_hash=data.get("content_hash", ""),
            deduplicated=data.get("deduplicated", False),
            corroborated=data.get("corroborated", False),
            supersedes=data.get("supersedes"),
            observed_by=data.get("observed_by", []),
            observation_count=data.get("observation_count", 1),
            warning=data.get("warning"),
        )


@dataclass
class Entity:
    """An entity from the knowledge graph."""
    id: int
    canonical_name: str
    entity_type: str
    mention_count: int = 0
    aliases: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Entity:
        return cls(
            id=data.get("id", 0),
            canonical_name=data.get("canonical_name", ""),
            entity_type=data.get("entity_type", ""),
            mention_count=data.get("mention_count", 0),
            aliases=data.get("aliases", []),
        )


@dataclass
class BriefingEntry:
    """A single entry in a briefing."""
    id: str
    content: str
    source_agent: str
    client_id: str = "global"
    importance: str = "medium"
    created_at: str = ""
    confidence: float = 1.0
    truncated: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BriefingEntry:
        return cls(
            id=data.get("id", ""),
            content=data.get("content", data.get("headline", "")),
            source_agent=data.get("source_agent", ""),
            client_id=data.get("client_id", "global"),
            importance=data.get("importance", "medium"),
            created_at=data.get("created_at", ""),
            confidence=data.get("confidence", 1.0),
            truncated=data.get("truncated", False),
        )


@dataclass
class Briefing:
    """A session briefing response."""
    since: str
    format: str
    requesting_agent: str
    generated_at: str
    summary: dict[str, Any]
    events: list[BriefingEntry] = field(default_factory=list)
    facts_updated: list[BriefingEntry] = field(default_factory=list)
    status_changes: list[BriefingEntry] = field(default_factory=list)
    decisions: list[BriefingEntry] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Briefing:
        def parse_entries(key: str) -> list[BriefingEntry]:
            return [BriefingEntry.from_dict(e) for e in data.get(key, [])]

        return cls(
            since=data.get("since", ""),
            format=data.get("format", "compact"),
            requesting_agent=data.get("requesting_agent", ""),
            generated_at=data.get("generated_at", ""),
            summary=data.get("summary", {}),
            events=parse_entries("events") or parse_entries("top_events"),
            facts_updated=parse_entries("facts_updated") or parse_entries("top_facts"),
            status_changes=parse_entries("status_changes") or parse_entries("top_statuses"),
            decisions=parse_entries("decisions") or parse_entries("top_decisions"),
        )


@dataclass
class Stats:
    """Memory health stats."""
    total_memories: int = 0
    vectors_count: int = 0
    active: int = 0
    superseded: int = 0
    consolidated: int = 0
    decayed_below_50pct: int = 0
    by_type: dict[str, int] = field(default_factory=dict)
    entities: Optional[dict[str, Any]] = None
    retrieval: Optional[dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Stats:
        return cls(
            total_memories=data.get("total_memories", 0),
            vectors_count=data.get("vectors_count", 0),
            active=data.get("active", 0),
            superseded=data.get("superseded", 0),
            consolidated=data.get("consolidated", 0),
            decayed_below_50pct=data.get("decayed_below_50pct", 0),
            by_type=data.get("by_type", {}),
            entities=data.get("entities"),
            retrieval=data.get("retrieval"),
        )


@dataclass
class GraphNode:
    """A node in the entity graph."""
    id: str
    type: str
    mention_count: int = 0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> GraphNode:
        return cls(
            id=data.get("id", ""),
            type=data.get("type", ""),
            mention_count=data.get("mention_count", 0),
        )


@dataclass
class GraphEdge:
    """An edge in the entity graph."""
    source: str
    target: str
    type: str = "co_occurrence"
    strength: int = 1

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> GraphEdge:
        return cls(
            source=data.get("source", ""),
            target=data.get("target", ""),
            type=data.get("type", "co_occurrence"),
            strength=data.get("strength", 1),
        )


@dataclass
class Graph:
    """Entity relationship graph."""
    center: str
    nodes: list[GraphNode]
    edges: list[GraphEdge]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Graph:
        return cls(
            center=data.get("center", ""),
            nodes=[GraphNode.from_dict(n) for n in data.get("nodes", [])],
            edges=[GraphEdge.from_dict(e) for e in data.get("edges", [])],
        )
