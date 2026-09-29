"""Tests for grouped paper search responses."""

from datetime import date

import pytest

from app.papers import service
from app.providers.base import Author, PaperMetadata, SearchResult


def make_paper(
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
        authors=[Author(name="Alice Smith"), Author(name="Bob Jones")],
        publication_date=publication_date,
        version=version,
        provider_source="openalex",
    )


def test_build_search_response_groups_versions_and_keeps_singletons():
    result = SearchResult(
        papers=[
            make_paper(
                canonical_key="hash:paper-v1",
                paper_group_key="group:paper",
                title="Grouped Paper",
                publication_date=date(2024, 1, 1),
                version="v1",
            ),
            make_paper(
                canonical_key="hash:paper-v2",
                paper_group_key="group:paper",
                title="Grouped Paper",
                publication_date=date(2025, 1, 1),
                version="v2",
            ),
            make_paper(
                canonical_key="hash:single",
                paper_group_key="group:single",
                title="Standalone Paper",
                publication_date=date(2023, 1, 1),
            ),
        ],
        total_count=3,
        page=1,
        page_size=20,
        provider="openalex",
    )

    payload = service.build_search_response(result)

    assert payload["total_count"] == 2
    assert payload["raw_total_count"] == 3
    assert payload["items"][0]["kind"] == "paper_group"
    assert payload["items"][0]["version_count"] == 2
    assert payload["items"][0]["selected_version"]["canonical_key"] == "hash:paper-v2"
    assert payload["items"][1]["kind"] == "paper"
    assert payload["items"][1]["paper"]["canonical_key"] == "hash:single"


def test_build_search_response_compares_versions_numerically():
    same_day = date(2024, 1, 1)
    result = SearchResult(
        papers=[
            make_paper("hash:v9", "group:paper", "Grouped Paper", same_day, "v9"),
            make_paper("hash:v10", "group:paper", "Grouped Paper", same_day, "v10"),
            make_paper("hash:v2", "group:paper", "Grouped Paper", same_day, "v2"),
        ],
        total_count=3,
        page=1,
        page_size=20,
        provider="crossref",
    )

    payload = service.build_search_response(result)

    group = payload["items"][0]
    assert group["selected_version"]["canonical_key"] == "hash:v10"
    assert [v["canonical_key"] for v in group["versions"]] == ["hash:v10", "hash:v9", "hash:v2"]


@pytest.mark.asyncio
async def test_cache_papers_roundtrip(db):
    papers = [
        make_paper(
            canonical_key="hash:paper-v2",
            paper_group_key="group:paper",
            title="Grouped Paper",
            publication_date=date(2025, 1, 1),
            version="v2",
        )
    ]

    await service.cache_papers(db, papers)
    cached = await service.get_cached_paper(db, "hash:paper-v2")

    assert cached is not None
    assert cached.paper_group_key == "group:paper"
    assert cached.title == "Grouped Paper"


def test_build_search_response_unions_provider_sources_at_group_level():
    """A paper group whose versions came from different providers must
    expose the union of their provider_sources at the group level."""
    p_v1 = make_paper(
        canonical_key="hash:paper-v1",
        paper_group_key="group:paper",
        title="Grouped",
        publication_date=date(2024, 1, 1),
        version="v1",
    )
    p_v1.provider_source = "arxiv"
    p_v1.provider_sources = ["arxiv"]

    p_v2 = make_paper(
        canonical_key="hash:paper-v2",
        paper_group_key="group:paper",
        title="Grouped",
        publication_date=date(2025, 1, 1),
        version="v2",
    )
    p_v2.provider_source = "openalex"
    p_v2.provider_sources = ["crossref", "openalex"]

    payload = service.build_search_response(
        SearchResult(papers=[p_v1, p_v2], total_count=2, page=1, page_size=20, provider="merged")
    )

    group = payload["items"][0]
    assert group["kind"] == "paper_group"
    assert group["provider_sources"] == ["arxiv", "crossref", "openalex"]
    # Per-version provider_sources flow through unchanged.
    selected = group["selected_version"]
    assert selected["provider_sources"] == ["crossref", "openalex"]


@pytest.mark.asyncio
async def test_cache_papers_unions_provider_sources_on_upsert(db):
    """Re-caching the same canonical_key with a different provider must
    union (not overwrite) the persisted provider_sources_json column."""
    first = make_paper(
        canonical_key="doi:10.1/x",
        paper_group_key="group:x",
        title="Shared",
        publication_date=date(2024, 1, 1),
    )
    first.provider_source = "openalex"
    first.provider_sources = ["openalex"]
    await service.cache_papers(db, [first])

    second = make_paper(
        canonical_key="doi:10.1/x",
        paper_group_key="group:x",
        title="Shared",
        publication_date=date(2024, 1, 1),
    )
    second.provider_source = "crossref"
    second.provider_sources = ["crossref"]
    await service.cache_papers(db, [second])

    cached = await service.get_cached_paper(db, "doi:10.1/x")
    assert cached is not None
    assert cached.provider_sources_json == ["crossref", "openalex"]


@pytest.mark.asyncio
async def test_cached_paper_to_read_falls_back_to_provider_source(db):
    """Old rows with no provider_sources_json (pre-migration data) must
    surface a non-empty provider_sources via the fallback."""
    paper = make_paper(
        canonical_key="doi:10.1/old",
        paper_group_key="group:old",
        title="Pre-migration",
        publication_date=date(2020, 1, 1),
    )
    paper.provider_source = "openalex"
    # provider_sources left empty intentionally — simulates pre-PR-1 state
    paper.provider_sources = []
    await service.cache_papers(db, [paper])

    cached = await service.get_cached_paper(db, "doi:10.1/old")
    assert cached is not None
    # cache_papers wrote [provider_source] via _provider_sources_for fallback;
    # if the row had been written before this PR existed, the JSON column
    # would be NULL — emulate that.
    cached.provider_sources_json = None
    read = service.cached_paper_to_read(cached)
    assert read.provider_sources == ["openalex"]
