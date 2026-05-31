"""API tests for grouped search responses."""

from datetime import date

import pytest
from httpx import ASGITransport, AsyncClient

from app.dependencies import get_db
from app.main import create_app
from app.providers.base import Author, PaperMetadata, SearchResult


def _paper(
    canonical_key: str,
    paper_group_key: str,
    title: str,
    publication_date: date | None,
    version: str | None = None,
) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=paper_group_key,
        title=title,
        authors=[Author(name="Alice Smith")],
        publication_date=publication_date,
        version=version,
        provider_source="openalex",
    )


@pytest.mark.asyncio
async def test_search_endpoint_returns_grouped_items(db, monkeypatch):
    async def override_db():
        yield db

    async def fake_search_all(*args, **kwargs):
        return [
            SearchResult(
                papers=[
                    _paper("hash:v1", "group:paper", "Grouped Paper", date(2024, 1, 1), "v1"),
                    _paper("hash:v2", "group:paper", "Grouped Paper", date(2025, 1, 1), "v2"),
                    _paper("hash:solo", "group:solo", "Solo Paper", date(2023, 1, 1)),
                ],
                total_count=3,
                page=1,
                page_size=20,
                provider="openalex",
            )
        ]

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    monkeypatch.setattr("app.providers.registry.search_all", fake_search_all)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/v1/papers/search", params={"q": "grouped"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_count"] == 2
    assert payload["items"][0]["kind"] == "paper_group"
    assert payload["items"][0]["selected_version"]["canonical_key"] == "hash:v2"
    assert payload["items"][1]["kind"] == "paper"
    assert payload["providers"] == ["openalex"]


@pytest.mark.asyncio
async def test_search_endpoint_merges_results_across_providers(db, monkeypatch):
    """Same paper returned by two providers shows up once with both badges."""
    async def override_db():
        yield db

    async def fake_search_all(*args, **kwargs):
        oa_paper = _paper("doi:10.1/x", "group:x", "Shared", date(2024, 1, 1))
        oa_paper.provider_source = "openalex"
        cr_paper = _paper("doi:10.1/x", "group:x", "Shared", date(2024, 1, 1))
        cr_paper.provider_source = "crossref"
        return [
            SearchResult(
                papers=[oa_paper], total_count=1, page=1, page_size=20, provider="openalex"
            ),
            SearchResult(
                papers=[cr_paper], total_count=1, page=1, page_size=20, provider="crossref"
            ),
        ]

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    monkeypatch.setattr("app.providers.registry.search_all", fake_search_all)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/v1/papers/search", params={"q": "shared"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_count"] == 1
    assert payload["raw_total_count"] == 2
    assert payload["providers"] == ["openalex", "crossref"]

    item = payload["items"][0]
    assert item["kind"] == "paper"
    assert item["paper"]["provider_sources"] == ["crossref", "openalex"]


@pytest.mark.asyncio
async def test_search_endpoint_returns_empty_payload_when_all_providers_fail(db, monkeypatch):
    async def override_db():
        yield db

    async def fake_search_all(*args, **kwargs):
        return []

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    monkeypatch.setattr("app.providers.registry.search_all", fake_search_all)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/v1/papers/search", params={"q": "anything"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["items"] == []
    assert payload["total_count"] == 0
    assert payload["providers"] == []
