"""Mocked HTTP regressions. Every outbound paper request must target S2 only."""

import copy
import json
from dataclasses import asdict, replace
from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select

from app.config import Settings, settings
from app.dependencies import get_db
from app.graph import service as graph_service
from app.main import create_app
from app.papers import service
from app.papers.models import CachedPaperMetadata
from app.providers import registry
from app.providers.base import Author, PaperMetadata, SearchFilters
from app.providers.identity import deduplicate, merge_metadata
from app.providers.semantic_scholar import (
    PAPER_FIELDS,
    ProviderError,
    SemanticScholarProvider,
    map_paper,
)

TITANS = json.loads((Path(__file__).parent / "fixtures/titans.json").read_text())


@pytest.fixture
async def provider(monkeypatch):
    monkeypatch.setattr(settings, "semantic_scholar_api_key", SecretStr("mock-private-key"))
    calls = []
    responses = []

    def handle(request):
        assert request.url.host == "api.semanticscholar.org"
        assert request.headers["x-api-key"] == "mock-private-key"
        assert "mock-private-key" not in str(request.url)
        calls.append(request)
        outcome = responses.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome if isinstance(outcome, httpx.Response) else httpx.Response(200, json=outcome)

    client = SemanticScholarProvider(transport=httpx.MockTransport(handle))
    monkeypatch.setattr(client._limiter, "acquire", AsyncMock())
    monkeypatch.setattr("app.providers.semantic_scholar.asyncio.sleep", AsyncMock())
    monkeypatch.setattr(registry, "_instances", {"semantic_scholar": client})
    yield client, responses, calls
    await client.close()


def test_mapping_and_optional_metadata():
    paper = map_paper(TITANS)
    assert paper.doi == "10.48550/arxiv.2501.00663"
    assert paper.arxiv_id == "2501.00663"
    assert paper.paper_type == "preprint"
    assert paper.semantic_scholar_id == TITANS["paperId"]
    assert paper.authors[0].semantic_scholar_id == "0001"
    assert paper.authors[0].openalex_id is None
    assert paper.cited_by_count == 341
    assert paper.raw_response is None
    minimal = map_paper({"paperId": "minimal", "title": "Minimal", "year": 2025})
    assert minimal.publication_date == date(2025, 1, 1)
    assert minimal.canonical_key == "s2:minimal"
    assert minimal.authors == [] and minimal.abstract is None
    assert (
        map_paper({"paperId": "a", "title": "A", "publicationDate": "bad"}).publication_date is None
    )


@pytest.mark.parametrize("raw", [{}, {"paperId": None, "title": "A"}, {"paperId": "x"}, None])
def test_invalid_paper_is_a_sanitized_error(raw):
    with pytest.raises(ProviderError):
        map_paper(raw)


async def test_search_and_identifiers_are_identical(provider):
    _p, responses, calls = provider
    responses.extend([{"data": [TITANS, TITANS], "total": 2}, TITANS, TITANS, TITANS])
    search = await registry.search_all(TITANS["title"])
    doi = await registry.lookup_by_doi("https://doi.org/10.48550/arXiv.2501.00663")
    arxiv = await registry.lookup_by_arxiv_id("2501.00663v2")
    s2 = await registry.lookup_by_id(TITANS["paperId"])
    assert len(search[0].papers) == 1
    assert asdict(search[0].papers[0]) == asdict(doi) == asdict(arxiv) == asdict(s2)
    assert all(c.url.params["fields"] == PAPER_FIELDS for c in calls)
    assert calls[2].url.path.endswith("ARXIV:2501.00663")
    assert set(registry._instances) == {"semantic_scholar"}


async def test_search_filters_and_page_boundary(provider):
    p, responses, calls = provider
    responses.append({"data": [TITANS], "total": 10000})
    result = await p.search(
        "test-time",
        SearchFilters(year_from=2024, year_to=2025, author="behrouz", open_access_only=True),
        10,
        100,
    )
    assert len(result.papers) == 1
    params = calls[0].url.params
    assert params["offset"] == "900" and params["limit"] == "100"
    assert params["year"] == "2024-2025" and params["openAccessPdf"] == ""
    assert params["query"] == "test time"
    with pytest.raises(ProviderError) as exc:
        await p.search("q", SearchFilters(), 11, 100)
    assert exc.value.status_code == 422 and len(calls) == 1
    responses.append({"data": [], "total": 0})
    empty = await p.search("q", SearchFilters())
    assert empty.papers == [] and empty.total_count == 0


@pytest.mark.parametrize("identifier", ["PMID:123", "PMCID:456", "s2:abc"])
async def test_supported_identifier_lookup(provider, identifier):
    p, responses, calls = provider
    responses.append(TITANS)
    await p.lookup_by_id(identifier)
    assert calls[0].url.path.endswith(identifier.removeprefix("s2:"))


async def test_graph_paginates_dedupes_merges_and_sorts(provider):
    _p, responses, calls = provider
    incomplete = {**TITANS, "abstract": None, "citationCount": None}
    other = {"paperId": "other", "title": "Other", "citationCount": 1, "year": 2026}
    pages = [
        {"data": [{"citingPaper": incomplete}, {"citingPaper": {"paperId": None}}], "next": 2},
        {"data": [{"citingPaper": TITANS}, {"citingPaper": other}]},
    ]
    responses.extend(copy.deepcopy(pages))
    papers = await registry.list_citing_papers("seed", limit=2)
    assert len(papers) == 2 and papers[0].semantic_scholar_id == TITANS["paperId"]
    assert papers[0].abstract == TITANS["abstract"]
    assert calls[1].url.params["offset"] == "2"
    responses.extend(copy.deepcopy(pages))
    recent = await registry.list_citing_papers("seed", order="recent", limit=1)
    assert recent[0].title == "Other"
    responses.extend(
        [
            {"data": [{"citedPaper": TITANS}], "next": 1},
            {"data": [{"citedPaper": TITANS}, {"citedPaper": other}]},
        ]
    )
    assert await registry.get_reference_ids("seed") == sorted([TITANS["paperId"], "other"])
    assert calls[-1].url.params["fields"] == "paperId"


@pytest.mark.parametrize(
    "data",
    [
        {"data": [], "next": 1},
        {"data": [{}]},
        {"data": [], "next": "x"},
        {"data": [{"citedPaper": TITANS}], "next": 0},
        {"data": [{"citedPaper": TITANS}], "next": 10000},
        {},
    ],
)
async def test_invalid_graph_pagination_fails_explicitly(provider, data):
    p, responses, _ = provider
    responses.append(data)
    with pytest.raises(ProviderError):
        await p.reference_ids("seed")


@pytest.mark.parametrize("failure", [429, 500, 503, "timeout", "connection"])
async def test_transient_retry(provider, failure):
    p, responses, calls = provider
    error = (
        httpx.ReadTimeout("private error")
        if failure == "timeout"
        else httpx.ConnectError("private error")
        if failure == "connection"
        else httpx.Response(failure, headers={"Retry-After": "0"}, json={"private": "data"})
    )
    responses.extend([error, TITANS])
    assert await p.lookup_by_doi("10.1/x") is not None
    assert len(calls) == 2


@pytest.mark.parametrize("status", [401, 403, 400])
async def test_permanent_errors_do_not_retry_or_expose_secrets(provider, status, caplog):
    p, responses, calls = provider
    responses.append(httpx.Response(status, text="mock-private-key"))
    with pytest.raises(ProviderError) as error:
        await p.lookup_by_id("x")
    assert len(calls) == 1
    assert "mock-private-key" not in str(error.value) + caplog.text
    assert error.value.status_code == (422 if status == 400 else 503)


async def test_missing_key_no_request(provider, monkeypatch):
    p, _, calls = provider
    monkeypatch.setattr(settings, "semantic_scholar_api_key", SecretStr(""))
    with pytest.raises(ProviderError) as error:
        await p.lookup_by_id("x")
    assert "SEMANTIC_SCHOLAR_API_KEY" in error.value.detail
    assert calls == []


async def test_not_found_malformed_and_retry_exhaustion(provider):
    p, responses, calls = provider
    responses.extend(
        [httpx.Response(404), httpx.Response(200, text="not json"), httpx.Response(200, json=[])]
    )
    assert await p.lookup_by_id("missing") is None
    for _ in range(2):
        with pytest.raises(ProviderError) as error:
            await p.lookup_by_id("bad")
        assert error.value.status_code == 502
    responses.extend([httpx.Response(429)] * 3)
    with pytest.raises(ProviderError) as error:
        await p.lookup_by_id("busy")
    assert error.value.status_code == 503 and len(calls) == 6


async def test_long_retry_after_is_not_retried_early(provider):
    p, responses, calls = provider
    responses.append(httpx.Response(429, headers={"Retry-After": "120"}))
    with pytest.raises(ProviderError) as error:
        await p.lookup_by_id("x")
    assert error.value.headers["Retry-After"] == "120" and len(calls) == 1


def test_inactive_providers_cannot_be_requested(provider):
    assert registry.ENABLED_PROVIDERS == ("semantic_scholar",)
    assert set(registry.PROVIDER_FACTORIES) == {
        "semantic_scholar",
        "openalex",
        "crossref",
        "arxiv",
        "europepmc",
    }
    for name in ("openalex", "crossref", "arxiv", "europepmc", "unknown"):
        with pytest.raises(ProviderError):
            registry.get_provider(name)


def test_strong_identity_complementary_merge_and_no_false_title_merge():
    full = map_paper(TITANS)
    sparse = replace(full, abstract=None, doi=None, canonical_key="s2:" + full.semantic_scholar_id)
    merged = deduplicate([sparse, full])
    assert len(merged) == 1 and merged[0].abstract and merged[0].doi
    assert asdict(merge_metadata(full, sparse)) == asdict(merge_metadata(sparse, full))
    other = replace(
        full, semantic_scholar_id="other", doi="10.2/other", canonical_key="doi:10.2/other"
    )
    assert len(deduplicate([full, other])) == 2
    arxiv = replace(
        full,
        semantic_scholar_id=None,
        doi=None,
        canonical_key="hash:arxiv",
        arxiv_id="https://arxiv.org/abs/2501.00663v3",
    )
    assert len(deduplicate([arxiv, sparse, full])) == 1
    assert full.abstract == TITANS["abstract"]  # Input is never mutated.


def test_title_fallback_requires_authors_year_and_no_strong_ids():
    one = PaperMetadata(
        "hash:one",
        "group:one",
        "An Exact: Title!",
        authors=[Author("Alice Smith")],
        publication_date=date(2025, 1, 1),
    )
    two = replace(one, canonical_key="hash:two", title="an exact title")
    assert len(deduplicate([one, two])) == 1
    assert len(deduplicate([one, replace(two, title="An almost exact title")])) == 2
    assert len(deduplicate([one, replace(two, authors=[Author("Bob Smith")])])) == 2
    assert len(deduplicate([one, replace(two, authors=[])])) == 2
    assert len(deduplicate([one, replace(two, doi="10.1/x")])) == 2


async def test_durable_identity_enrichment_and_alias_resolution(db):
    full = map_paper(TITANS)
    sparse = replace(full, doi=None, abstract=None, canonical_key="s2:" + full.semantic_scholar_id)
    await service.cache_papers(db, [sparse, sparse])
    stored = await service.cache_papers(db, [full])
    assert stored[0].canonical_key == sparse.canonical_key
    rows = (await db.execute(select(CachedPaperMetadata))).scalars().all()
    assert len(rows) == 1 and rows[0].abstract == full.abstract
    assert (await service.get_paper_detail(db, full.canonical_key))[
        "canonical_key"
    ] == sparse.canonical_key
    assert (await service.get_paper_detail(db, "arxiv:2501.00663v2"))[
        "semantic_scholar_id"
    ] == full.semantic_scholar_id


async def test_real_api_service_pipeline_and_graph(provider, db):
    _p, responses, calls = provider
    responses.extend(
        [
            {"data": [TITANS, TITANS], "total": 2},
            {"data": [{"citingPaper": {"paperId": "citer", "title": "Citer", "year": 2026}}]},
            {"data": [{"citedPaper": {"paperId": "citer"}}]},
            {"data": []},
        ]
    )
    app = create_app()

    async def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as api:
        found = await api.get("/api/v1/papers/search", params={"q": TITANS["title"]})
        assert found.status_code == 200
        result = found.json()
        assert result["providers"] == ["semantic_scholar"] and len(result["items"]) == 1
        paper = result["items"][0]["paper"]
        detail = await api.get("/api/v1/papers/" + paper["canonical_key"])
        assert detail.json()["semantic_scholar_id"] == TITANS["paperId"]
        assert detail.json()["authors"][0]["semantic_scholar_id"] == "0001"
        # Cache hit must not issue more HTTP requests.
        await api.get("/api/v1/papers/search", params={"q": TITANS["title"]})
        assert len(calls) == 1
        denied = await api.get("/api/v1/papers/search", params={"q": "x", "providers": "openalex"})
        assert denied.status_code == 422 and len(calls) == 1
    expanded = await graph_service.expand_graph(db, None, from_keys=[paper["canonical_key"]])
    assert len(expanded.nodes) == 1 and len(expanded.edges) == 1
    base = await graph_service.build_base_graph(db, None, [paper["canonical_key"], "s2:citer"])
    assert len(base.edges) == 1
    assert set(registry._instances) == {"semantic_scholar"}


def test_secret_settings_and_secret_file(tmp_path):
    secret = tmp_path / "key"
    secret.write_text("file-private-key\n")
    config = Settings(_env_file=None, semantic_scholar_api_key_file=str(secret))
    assert config.semantic_scholar_api_key.get_secret_value() == "file-private-key"
    assert "file-private-key" not in repr(config)


async def test_search_past_last_page_is_empty_but_other_400s_fail(provider):
    p, responses, calls = provider
    responses.append(
        httpx.Response(
            400, json={"error": "Requested data for this limit and/or offset is not available"}
        )
    )
    result = await p.search("q", SearchFilters(), page=2)
    assert result.papers == [] and result.page == 2
    responses.append(httpx.Response(400, json={"error": "Bad filter"}))
    with pytest.raises(ProviderError):
        await p.search("q", SearchFilters(), page=2)
    assert len(calls) == 2


async def test_legacy_graph_uses_doi_and_updates_s2_identity(provider, db):
    _p, responses, calls = provider
    from app.providers.base import PaperMetadata

    legacy = PaperMetadata(
        canonical_key="doi:10.48550/arxiv.2501.00663",
        paper_group_key="group:legacy",
        title=TITANS["title"],
        doi="10.48550/arxiv.2501.00663",
        openalex_id="https://openalex.org/Wlegacy",
        provider_source="openalex",
    )
    await service.cache_papers(db, [legacy])
    responses.extend([TITANS, {"data": []}])
    await graph_service.expand_graph(db, None, from_keys=[legacy.canonical_key])
    assert calls[0].url.path.endswith("DOI:10.48550/arxiv.2501.00663")
    row = await service.get_cached_paper(db, legacy.canonical_key)
    assert row.semantic_scholar_id == TITANS["paperId"]
    assert row.paper_group_key == "group:legacy"


async def test_missing_key_api_error_is_not_cached(provider, db, monkeypatch):
    _p, responses, calls = provider
    app = create_app()

    async def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    monkeypatch.setattr(settings, "semantic_scholar_api_key", SecretStr(""))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as api:
        error = await api.get("/api/v1/papers/search", params={"q": "Titans"})
        assert error.status_code == 503 and "SEMANTIC_SCHOLAR_API_KEY" in error.json()["detail"]
        assert calls == []
        monkeypatch.setattr(settings, "semantic_scholar_api_key", SecretStr("mock-private-key"))
        responses.append({"data": [TITANS], "total": 1})
        success = await api.get("/api/v1/papers/search", params={"q": "Titans"})
        assert success.status_code == 200 and len(calls) == 1


def test_identifier_bridge_merges_transitively_and_keeps_conflicts_separate():
    one = map_paper(TITANS)
    s2_only = replace(one, doi=None, arxiv_id=None, canonical_key="s2:" + one.semantic_scholar_id)
    doi_only = replace(one, semantic_scholar_id=None, arxiv_id=None)
    assert len(deduplicate([s2_only, doi_only, one])) == 1
    conflict = replace(
        one, semantic_scholar_id="conflict", doi="10.2/conflict", canonical_key="doi:10.2/conflict"
    )
    assert len(deduplicate([conflict, s2_only, one, doi_only])) == 2


def test_unicode_and_doi_punctuation_normalization():
    one = map_paper(TITANS)
    altered = replace(
        one, doi="https://DOI.org/10.48550/ARXIV.2501.00663 ", semantic_scholar_id=None
    )
    assert len(deduplicate([one, altered])) == 1
    unicode = PaperMetadata(
        "hash:one",
        "group:x",
        "ÉTUDE — mémoire",
        authors=[Author("Zoë Martin")],
        publication_date=date(2025, 1, 1),
    )
    assert (
        len(
            deduplicate(
                [unicode, replace(unicode, canonical_key="hash:two", title="étude mémoire")]
            )
        )
        == 1
    )


def test_complementary_merging_is_independent_of_combination_order():
    from itertools import permutations

    base = map_paper(TITANS)
    records = [
        replace(base, abstract="A", venue="Long venue", pdf_url=None),
        replace(base, abstract="B", venue=None, pdf_url="https://pdf"),
        replace(base, abstract="C", venue=None, pdf_url=None, topics=["New topic"]),
    ]
    outputs = [asdict(deduplicate(list(order))[0]) for order in permutations(records)]
    assert all(item == outputs[0] for item in outputs)
    abbreviated = replace(base, authors=[Author(name="A. Behrouz", semantic_scholar_id="0001")])
    merged = deduplicate([base, abbreviated])[0]
    assert len(merged.authors) == 3 and merged.authors[0].name == "Ali Behrouz"


def test_conflicting_strong_ids_do_not_merge_via_legacy_hash():
    one = map_paper(TITANS)
    one = replace(one, canonical_key="hash:same", doi=None, arxiv_id=None)
    two = replace(one, semantic_scholar_id="different")
    assert len(deduplicate([one, two])) == 2


def test_merged_aliases_remain_matchable_after_identifier_tie_break():
    one = map_paper(TITANS)
    alternate = replace(one, semantic_scholar_id="z" * 40)
    sparse_alternate = replace(
        alternate, doi=None, arxiv_id=None, canonical_key="s2:" + alternate.semantic_scholar_id
    )
    assert len(deduplicate([one, alternate, sparse_alternate])) == 1


def test_legacy_surname_hash_collision_does_not_merge_distinct_authors():
    from app.providers.base import build_canonical_key

    key = build_canonical_key(title="Same title", authors=["Alice Smith"], year=2025)
    assert key == build_canonical_key(title="Same title", authors=["Bob Smith"], year=2025)
    one = PaperMetadata(
        key,
        "group:x",
        "Same title",
        authors=[Author("Alice Smith")],
        publication_date=date(2025, 1, 1),
    )
    assert len(deduplicate([one, replace(one, authors=[Author("Bob Smith")])])) == 2


async def test_normalized_publication_types_reach_zotero(db):
    from app.zotero.service import item_from_cached

    preprint = map_paper(TITANS)
    conference = map_paper(
        {
            "paperId": "conference",
            "title": "Conference paper",
            "publicationTypes": ["JournalArticle", "Conference"],
        }
    )
    chapter = map_paper(
        {"paperId": "chapter", "title": "Chapter", "publicationTypes": ["BookSection"]}
    )
    stored = await service.cache_papers(db, [preprint, conference, chapter])
    types = [
        item_from_cached(await service.get_cached_paper(db, p.canonical_key), "collection")[
            "itemType"
        ]
        for p in stored
    ]
    assert types == ["preprint", "conferencePaper", "bookSection"]
