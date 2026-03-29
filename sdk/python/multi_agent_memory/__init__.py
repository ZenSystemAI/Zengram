"""Multi-Agent Memory — Python SDK for cross-machine, cross-agent persistent memory."""

from .client import AsyncBrainClient, BrainClient, BrainError, RateLimitError
from .models import (
    Briefing,
    BriefingEntry,
    Entity,
    Graph,
    GraphEdge,
    GraphNode,
    Memory,
    SearchResponse,
    SearchResult,
    Stats,
    StoreResult,
)

__version__ = "0.1.0"
__all__ = [
    "BrainClient",
    "AsyncBrainClient",
    "BrainError",
    "RateLimitError",
    "Memory",
    "SearchResult",
    "SearchResponse",
    "StoreResult",
    "Entity",
    "Briefing",
    "BriefingEntry",
    "Stats",
    "Graph",
    "GraphNode",
    "GraphEdge",
]
