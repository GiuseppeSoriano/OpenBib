"""Redis-backed caching of search responses and sorted bulk-search batches."""

import json
from datetime import date

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.dependencies import get_db, get_redis
from app.main import create_app
from app.providers import registry
from app.providers.base import Author, BulkSearchPage, PaperMetadata, SearchResult
from app.providers.semantic_scholar import ProviderError


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
async def test_answered_search_with_no_matches_is_cached(db, monkeypatch):
    calls = {"count": 0}

    async def no_matches(*args, **kwargs):
        calls["count"] += 1
        return [
            SearchResult(
                papers=[], total_count=0, page=1, page_size=20, provider="semantic_scholar"
            )
        ]

    fake_redis = FakeRedis()
    app = _make_app(db, fake_redis)
    monkeypatch.setattr("app.providers.registry.search_all", no_matches)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        first = await client.get("/api/v1/papers/search", params={"q": "nothing"})
        second = await client.get("/api/v1/papers/search", params={"q": "nothing"})

    # Only a raised provider error skips the cache (test_provider_errors_are_not_cached).
    assert first.json()["items"] == [] and second.json() == first.json()
    assert calls["count"] == 1
    assert len(fake_redis.store) == 1


@pytest.mark.asyncio
async def test_cached_legacy_markup_is_normalized_on_read(db, monkeypatch):
    async def fake_search_all(*args, **kwargs):
        return [
            SearchResult(
                papers=[
                    _paper("doi:10.1/v1", "group:legacy", "Legacy Paper"),
                    _paper("doi:10.1/v2", "group:legacy", "Legacy Paper"),
                ],
                total_count=2,
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
        await client.get("/api/v1/papers/search", params={"q": "legacy"})
        # Simulate an entry cached before provider text was normalized.
        key, value = next(iter(fake_redis.store.items()))
        payload = json.loads(value)
        group = payload["items"][0]
        assert group["kind"] == "paper_group"
        group["title"] = "Legacy <i>Paper</i>"
        group["selected_version"]["title"] = "Legacy <i>Paper</i>"
        group["selected_version"]["abstract"] = "<h4>Background</h4>Raw.<h4>Results</h4>Done."
        group["versions"][1]["abstract"] = "Plain &amp; <b>bold</b>"
        fake_redis.store[key] = json.dumps(payload)

        response = await client.get("/api/v1/papers/search", params={"q": "legacy"})

    group = response.json()["items"][0]
    assert group["title"] == "Legacy Paper"
    assert group["selected_version"]["title"] == "Legacy Paper"
    assert group["selected_version"]["abstract"] == "Background: Raw.\n\nResults: Done."
    assert group["versions"][1]["abstract"] == "Plain & bold"


def _counting_search_all(monkeypatch) -> dict:
    calls = {"count": 0}

    async def fake_search_all(*args, **kwargs):
        calls["count"] += 1
        return [
            SearchResult(
                papers=[_paper("doi:10.1/v", "group:v", "Versioned Paper")],
                total_count=1,
                page=1,
                page_size=20,
                provider="semantic_scholar",
            )
        ]

    monkeypatch.setattr("app.providers.registry.search_all", fake_search_all)
    return calls


@pytest.mark.asyncio
async def test_search_cache_key_carries_the_response_version(db, monkeypatch):
    calls = _counting_search_all(monkeypatch)
    fake_redis = FakeRedis()
    transport = ASGITransport(app=_make_app(db, fake_redis))
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.get("/api/v1/papers/search", params={"q": "versioned"})
        await client.get("/api/v1/papers/search", params={"q": "versioned"})
        assert calls["count"] == 1
        # Entries of an older response shape are never served.
        monkeypatch.setattr(registry, "SEARCH_CACHE_VERSION", "v-next")
        await client.get("/api/v1/papers/search", params={"q": "versioned"})

    assert calls["count"] == 2
    assert registry.CACHE_NAMESPACE == "papers-v3:semantic_scholar"
    assert all(
        key.startswith(f"openbib:cache:{registry.CACHE_NAMESPACE}:search:")
        for key in fake_redis.store
    )


@pytest.mark.asyncio
async def test_provider_errors_are_not_cached(db, monkeypatch):
    calls = {"count": 0}

    async def failing(*args, **kwargs):
        calls["count"] += 1
        raise ProviderError("provider_unavailable", "Down.", retry_after=5)

    monkeypatch.setattr("app.providers.registry.search_all", failing)
    monkeypatch.setattr("app.providers.registry.search_sorted", failing)
    fake_redis = FakeRedis()
    transport = ASGITransport(app=_make_app(db, fake_redis))
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        for sort in ("relevance", "relevance", "date", "date"):
            response = await client.get("/api/v1/papers/search", params={"q": "x", "sort": sort})
            assert response.status_code == 503

    assert calls["count"] == 4
    assert fake_redis.store == {}


@pytest.mark.asyncio
async def test_sort_and_cursor_give_distinct_cache_entries(db, monkeypatch):
    relevance = _counting_search_all(monkeypatch)
    bulk_calls: list = []

    async def fake_search_sorted(query, filters=None, sort="citations", token=None):
        bulk_calls.append((sort, token))
        items = [_paper(f"doi:10.1/{sort}{i}", f"group:{sort}{i}", f"Sorted {i}") for i in range(3)]
        return BulkSearchPage(items=items, total=3)

    monkeypatch.setattr("app.providers.registry.search_sorted", fake_search_sorted)
    transport = ASGITransport(app=_make_app(db, FakeRedis()))
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        for sort in ("relevance", "date", "citations"):
            await client.get("/api/v1/papers/search", params={"q": "same", "sort": sort})
        first = await client.get(
            "/api/v1/papers/search", params={"q": "same", "sort": "date", "size": 2}
        )
        cursor = first.json()["next_cursor"]
        second = await client.get(
            "/api/v1/papers/search",
            params={"q": "same", "sort": "date", "size": 2, "cursor": cursor},
        )

    assert relevance["count"] == 1
    assert bulk_calls == [("date", None), ("citations", None)]
    assert [item["paper"]["canonical_key"] for item in second.json()["items"]] == ["doi:10.1/date2"]


@pytest.mark.asyncio
async def test_bulk_batches_are_cached_once_and_reused_by_later_slices(db, monkeypatch):
    calls: list = []

    async def fake_search_sorted(query, filters=None, sort="citations", token=None):
        calls.append(token)
        items = [_paper(f"doi:10.1/b{i}", f"group:b{i}", f"Bulk {i}") for i in range(5)]
        items[0].publication_date = None
        return BulkSearchPage(items=items, total=900, token="MORE")

    monkeypatch.setattr("app.providers.registry.search_sorted", fake_search_sorted)
    fake_redis = FakeRedis()
    transport = ASGITransport(app=_make_app(db, fake_redis))
    params = {"q": "bulk", "sort": "citations", "size": 2}
    pages = []
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        for _ in range(3):
            response = await client.get("/api/v1/papers/search", params=params)
            pages.append(response.json())
            params = {**params, "cursor": response.json()["next_cursor"]}

    assert calls == [None]
    assert [[i["paper"]["canonical_key"] for i in page["items"]] for page in pages] == [
        ["doi:10.1/b0", "doi:10.1/b1"],
        ["doi:10.1/b2", "doi:10.1/b3"],
        ["doi:10.1/b4"],
    ]
    # The last slice of a batch continues with the provider's token.
    assert pages[2]["next_cursor"] and pages[2]["has_more"] is True
    bulk_keys = [key for key in fake_redis.store if ":search-bulk:" in key]
    assert len(bulk_keys) == 1
    assert bulk_keys[0].startswith(f"openbib:cache:{registry.CACHE_NAMESPACE}:search-bulk:")
    assert fake_redis.ttls[bulk_keys[0]] == settings.cache_ttl_search
    batch = json.loads(fake_redis.store[bulk_keys[0]])
    assert (batch["total"], batch["token"], len(batch["items"])) == (900, "MORE", 5)


@pytest.mark.asyncio
async def test_only_the_served_slice_is_written_to_the_database(db, monkeypatch):
    from app.papers.service import get_cached_paper

    async def fake_search_sorted(query, filters=None, sort="citations", token=None):
        items = [_paper(f"doi:10.1/s{i}", f"group:s{i}", f"Slice {i}") for i in range(4)]
        return BulkSearchPage(items=items, total=4)

    monkeypatch.setattr("app.providers.registry.search_sorted", fake_search_sorted)
    transport = ASGITransport(app=_make_app(db, FakeRedis()))
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.get("/api/v1/papers/search", params={"q": "s", "sort": "date", "size": 2})

    assert await get_cached_paper(db, "doi:10.1/s1") is not None
    assert await get_cached_paper(db, "doi:10.1/s2") is None


@pytest.mark.asyncio
async def test_unreadable_or_unavailable_batch_cache_falls_back_to_the_provider(db, monkeypatch):
    calls: list = []

    async def fake_search_sorted(query, filters=None, sort="citations", token=None):
        calls.append(token)
        return BulkSearchPage(items=[_paper("doi:10.1/u", "group:u", "Unreadable")], total=1)

    monkeypatch.setattr("app.providers.registry.search_sorted", fake_search_sorted)
    fake_redis = FakeRedis()
    transport = ASGITransport(app=_make_app(db, fake_redis))
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.get("/api/v1/papers/search", params={"q": "u", "sort": "date"})
        for key in list(fake_redis.store):
            fake_redis.store[key] = "{not json" if ":search-bulk:" in key else fake_redis.store[key]
        await client.get("/api/v1/papers/search", params={"q": "u", "sort": "date", "size": 5})

        async def redis_down(*args, **kwargs):
            raise ConnectionError("redis down")

        fake_redis.get = redis_down
        fake_redis.set = redis_down
        response = await client.get("/api/v1/papers/search", params={"q": "u", "sort": "date"})

    assert response.status_code == 200
    assert [item["paper"]["canonical_key"] for item in response.json()["items"]] == ["doi:10.1/u"]
    assert calls == [None, None, None]
