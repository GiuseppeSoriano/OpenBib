"""Redis-backed caching of the multi-provider search fan-out."""

from datetime import date

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.dependencies import get_db, get_redis
from app.main import create_app
from app.providers.base import Author, PaperMetadata, SearchResult


class FakeRedis:
    """Minimal async Redis stand-in: get/set with TTL bookkeeping."""

    def __init__(self):
        self.store: dict[str, str] = {}
        self.ttls: dict[str, int | None] = {}

    async def eval(self, *args):
        return [1, 99, 0]  # Cache-specific stand-in; token buckets have separate tests.

    async def get(self, key: str):
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: int | None = None):
        self.store[key] = value
        self.ttls[key] = ex


def _paper(canonical_key: str, group_key: str, title: str) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        title=title,
        authors=[Author(name="Alice Smith")],
        publication_date=date(2024, 1, 1),
        provider_source="openalex",
    )


def _make_app(db, fake_redis: FakeRedis):
    async def override_db():
        yield db

    async def override_redis():
        return fake_redis

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_redis] = override_redis
    return app


@pytest.mark.asyncio
async def test_repeat_search_is_served_from_cache(db, monkeypatch):
    calls = {"count": 0}

    async def fake_search_all(*args, **kwargs):
        calls["count"] += 1
        return [
            SearchResult(
                papers=[_paper("doi:10.1/a", "group:a", "Cached Paper")],
                total_count=1,
                page=1,
                page_size=20,
                provider="openalex",
            )
        ]

    fake_redis = FakeRedis()
    app = _make_app(db, fake_redis)
    monkeypatch.setattr("app.providers.registry.search_all", fake_search_all)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        first = await client.get("/api/v1/papers/search", params={"q": "attention"})
        second = await client.get("/api/v1/papers/search", params={"q": "attention"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert calls["count"] == 1, "second identical search must not hit providers"
    assert first.json() == second.json()

    # The cached entry carries the configured search TTL.
    assert list(fake_redis.ttls.values()) == [settings.cache_ttl_search]


@pytest.mark.asyncio
async def test_different_query_or_filters_bypass_cache(db, monkeypatch):
    calls = {"count": 0}

    async def fake_search_all(*args, **kwargs):
        calls["count"] += 1
        return [
            SearchResult(
                papers=[_paper("doi:10.1/b", "group:b", "Other Paper")],
                total_count=1,
                page=1,
                page_size=20,
                provider="openalex",
            )
        ]

    app = _make_app(db, FakeRedis())
    monkeypatch.setattr("app.providers.registry.search_all", fake_search_all)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.get("/api/v1/papers/search", params={"q": "transformers"})
        await client.get("/api/v1/papers/search", params={"q": "transformers", "page": 2})
        await client.get("/api/v1/papers/search", params={"q": "transformers", "year_from": 2020})

    assert calls["count"] == 3, "changed page/filters must produce distinct cache keys"


@pytest.mark.asyncio
async def test_total_provider_failure_is_not_cached(db, monkeypatch):
    calls = {"count": 0}

    async def failing_search_all(*args, **kwargs):
        calls["count"] += 1
        return []

    fake_redis = FakeRedis()
    app = _make_app(db, fake_redis)
    monkeypatch.setattr("app.providers.registry.search_all", failing_search_all)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.get("/api/v1/papers/search", params={"q": "flaky"})
        await client.get("/api/v1/papers/search", params={"q": "flaky"})

    assert calls["count"] == 2, "empty (all-providers-down) responses must not be cached"
    assert fake_redis.store == {}
