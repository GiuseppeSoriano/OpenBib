"""Redis-backed cache layer for provider responses."""

from __future__ import annotations

import hashlib
import json
from typing import Any

import redis.asyncio as aioredis

from app.config import settings


def _cache_key(provider: str, query_type: str, identifier: str) -> str:
    """Build a Redis cache key: openbib:cache:{provider}:{query_type}:{hash}."""
    h = hashlib.sha256(identifier.encode()).hexdigest()[:12]
    return f"openbib:cache:{provider}:{query_type}:{h}"


def _ttl_for(query_type: str) -> int:
    mapping = {
        "lookup": settings.cache_ttl_lookup,
        "search": settings.cache_ttl_search,
        "references": settings.cache_ttl_references,
        "citations": settings.cache_ttl_citations,
        "author": settings.cache_ttl_author,
    }
    return mapping.get(query_type, settings.cache_ttl_lookup)


async def cache_get(
    redis: aioredis.Redis, provider: str, query_type: str, identifier: str
) -> dict | None:
    key = _cache_key(provider, query_type, identifier)
    raw = await redis.get(key)
    if raw is None:
        return None
    return json.loads(raw)


async def cache_set(
    redis: aioredis.Redis,
    provider: str,
    query_type: str,
    identifier: str,
    data: Any,
) -> None:
    key = _cache_key(provider, query_type, identifier)
    ttl = _ttl_for(query_type)
    await redis.set(key, json.dumps(data, default=str), ex=ttl)
