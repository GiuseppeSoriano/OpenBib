"""Public paper-detail endpoint: cache hit, provider fallback, 404s."""

from datetime import date

import pytest
from httpx import ASGITransport, AsyncClient

from app.dependencies import get_db
from app.main import create_app
from app.papers.service import cache_papers
from app.providers.base import Author, PaperMetadata


def _paper(
    canonical_key: str,
    group_key: str,
    title: str,
    publication_date: date | None = date(2024, 1, 1),
    version: str | None = None,
) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        title=title,
        authors=[Author(name="Alice Smith")],
        abstract="An abstract.",
        publication_date=publication_date,
        doi=canonical_key.removeprefix("doi:") if canonical_key.startswith("doi:") else None,
        venue="Journal of Tests",
        cited_by_count=42,
        version=version,
        provider_source="openalex",
    )


def _make_app(db):
    async def override_db():
        yield db

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    return app


@pytest.mark.asyncio
async def test_detail_served_from_cached_metadata_without_auth(db):
    await cache_papers(db, [_paper("doi:10.1/detail", "group:detail", "Cached Detail")])
    app = _make_app(db)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/v1/papers/doi:10.1/detail")

    assert response.status_code == 200
    payload = response.json()
    assert payload["title"] == "Cached Detail"
    assert payload["venue"] == "Journal of Tests"
    assert payload["cited_by_count"] == 42
    assert [v["canonical_key"] for v in payload["versions"]] == ["doi:10.1/detail"]


@pytest.mark.asyncio
async def test_detail_lists_sibling_versions_of_the_group(db):
    await cache_papers(
        db,
        [
            _paper("hash:v1", "group:multi", "Multi Version", date(2023, 1, 1), "v1"),
            _paper("hash:v2", "group:multi", "Multi Version", date(2024, 6, 1), "v2"),
        ],
    )
    app = _make_app(db)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/v1/papers/hash:v1")

    assert response.status_code == 200
    payload = response.json()
    assert payload["canonical_key"] == "hash:v1"
    keys = {v["canonical_key"] for v in payload["versions"]}
    assert keys == {"hash:v1", "hash:v2"}


@pytest.mark.asyncio
async def test_detail_falls_back_to_doi_lookup_on_cache_miss(db, monkeypatch):
    looked_up = {}

    async def fake_lookup_by_doi(doi: str):
        looked_up["doi"] = doi
        return _paper("doi:10.9/fresh", "group:fresh", "Freshly Fetched")

    monkeypatch.setattr("app.providers.registry.lookup_by_doi", fake_lookup_by_doi)
    app = _make_app(db)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/v1/papers/doi:10.9/fresh")

    assert response.status_code == 200
    assert looked_up["doi"] == "10.9/fresh"
    assert response.json()["title"] == "Freshly Fetched"

    # The lookup upserted the durable snapshot: a second request needs no provider.
    async def exploding_lookup(doi: str):
        raise AssertionError("provider must not be called again")

    monkeypatch.setattr("app.providers.registry.lookup_by_doi", exploding_lookup)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        again = await client.get("/api/v1/papers/doi:10.9/fresh")
    assert again.status_code == 200


@pytest.mark.asyncio
async def test_detail_404_for_unknown_hash_key(db, monkeypatch):
    async def fake_lookup_by_doi(doi: str):
        raise AssertionError("hash keys must not trigger DOI lookups")

    monkeypatch.setattr("app.providers.registry.lookup_by_doi", fake_lookup_by_doi)
    app = _make_app(db)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/v1/papers/hash:doesnotexist")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_detail_route_does_not_shadow_sibling_routes(db):
    """/search and /dismissed must still resolve to their own handlers."""
    app = _make_app(db)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        dismissed = await client.get("/api/v1/papers/dismissed")
        search = await client.get("/api/v1/papers/search", params={"q": ""})

    # /dismissed requires auth → 401 (not 404 from the detail route)
    assert dismissed.status_code == 401
    # /search validates q → 422 (not 404 from the detail route)
    assert search.status_code == 422
