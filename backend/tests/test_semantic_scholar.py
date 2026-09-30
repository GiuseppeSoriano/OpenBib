"""Mocked HTTP regressions. Every outbound paper request must target S2 only."""

import json
from dataclasses import asdict, replace
from datetime import date
from pathlib import Path

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
from app.providers.base import Author, PaperMetadata, SearchFilters, build_paper_group_key
from app.providers.identity import deduplicate, merge_metadata
from app.providers.semantic_scholar import (
    DEFAULT_RETRY_AFTER,
    PAPER_FIELDS,
    RELATED_FIELDS,
    ProviderError,
    _retry_delay,
    map_paper,
)

TITANS = json.loads((Path(__file__).parent / "fixtures/titans.json").read_text())


@pytest.fixture
def provider(s2_mock):
    return s2_mock.provider, s2_mock.responses, s2_mock.calls


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
    # Relevance search requires offset + limit < 1000.
    assert params["offset"] == "900" and params["limit"] == "99"
    assert params["year"] == "2024-2025" and params["openAccessPdf"] == ""
    assert params["query"] == "test time"
    assert result.total_estimate == 10000
    with pytest.raises(ProviderError) as exc:
        await p.search("q", SearchFilters(), 11, 100)
    assert exc.value.status_code == 422 and len(calls) == 1
    assert exc.value.code == "search_window_exceeded"
    responses.append({"data": [], "total": 0})
    empty = await p.search("q", SearchFilters())
    assert empty.papers == [] and empty.total_count == 0


@pytest.mark.parametrize("identifier", ["PMID:123", "PMCID:456", "s2:abc"])
async def test_supported_identifier_lookup(provider, identifier):
    p, responses, calls = provider
    responses.append(TITANS)
    await p.lookup_by_id(identifier)
    assert calls[0].url.path.endswith(identifier.removeprefix("s2:"))


async def test_related_pages_are_compact_entries_by_offset(provider):
    _p, responses, calls = provider
    other = {"paperId": "OTHER", "title": "Other", "citationCount": 1, "year": 2026}
    responses.extend(
        [
            {"data": [{"citingPaper": TITANS}, {"citingPaper": {"paperId": None}}], "next": 2},
            {"data": [{"citingPaper": other}]},
        ]
    )
    first = await registry.related_page(TITANS["paperId"], "cited_by")
    params = calls[0].url.params
    assert calls[0].url.path.endswith(f"/paper/{TITANS['paperId']}/citations")
    assert params["fields"] == RELATED_FIELDS
    assert (params["offset"], params["limit"]) == ("0", str(settings.graph_related_chunk_size))
    paper = map_paper(TITANS)
    assert first.entries == [
        [
            paper.semantic_scholar_id,
            paper.canonical_key,
            paper.paper_group_key,
            paper.publication_date.toordinal(),
            paper.cited_by_count,
        ]
    ]
    assert (first.next, first.exhausted, first.capped) == (2, False, False)
    last = await registry.related_page(TITANS["paperId"], "cited_by", offset=2, limit=50)
    assert (calls[1].url.params["offset"], calls[1].url.params["limit"]) == ("2", "50")
    group = build_paper_group_key("Other", [])
    assert last.entries == [["other", "s2:other", group, date(2026, 1, 1).toordinal(), 1]]
    assert (last.next, last.exhausted, last.capped) == (None, True, False)
    responses.append({"data": []})
    await registry.related_page("DOI:10.1/x", "cites")
    assert calls[2].url.raw_path.startswith(b"/graph/v1/paper/DOI:10.1%2Fx/references?")


async def test_related_paging_stops_below_the_provider_limit(provider):
    _p, responses, calls = provider
    responses.append({"data": [{"citedPaper": TITANS}], "next": 9999})
    page = await registry.related_page("seed", "cites", offset=9500)
    # offset + limit must stay below 10,000.
    assert calls[0].url.params["limit"] == "499"
    assert (page.next, page.exhausted, page.capped) == (None, True, True)
    beyond = await registry.related_page("seed", "cites", offset=9999)
    assert beyond.entries == [] and beyond.capped and len(calls) == 1
    responses.append(httpx.Response(404))
    unknown = await registry.related_page("missing", "cited_by")
    assert (unknown.entries, unknown.exhausted, unknown.capped) == ([], True, False)


async def test_reference_ids_page_dedupe_and_cap_without_failing(provider):
    _p, responses, calls = provider
    other = {"paperId": "other", "title": "Other"}
    responses.extend(
        [
            {"data": [{"citedPaper": TITANS}, {"citedPaper": {"paperId": None}}], "next": 1},
            {"data": [{"citedPaper": TITANS}, {"citedPaper": other}], "next": 9999},
        ]
    )
    assert await registry.get_reference_ids("seed") == sorted([TITANS["paperId"], "other"])
    assert calls[-1].url.params["fields"] == "paperId"
    assert calls[-1].url.params["offset"] == "1" and len(calls) == 2


@pytest.mark.parametrize(
    "data",
    [
        {"data": [], "next": 1},
        {"data": [{}]},
        {"data": [], "next": "x"},
        {"data": [{"citedPaper": TITANS}], "next": 0},
        {},
        [],
    ],
)
async def test_invalid_graph_pagination_fails_explicitly(provider, data):
    p, responses, _ = provider
    responses.append(data)
    with pytest.raises(ProviderError) as error:
        await p.reference_ids("seed")
    assert (error.value.status_code, error.value.code) == (502, "provider_bad_response")


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


@pytest.mark.parametrize(
    ("status", "code", "http_status"),
    [
        (401, "provider_key_rejected", 503),
        (403, "provider_key_rejected", 503),
        (400, "invalid_query", 422),
        (418, "provider_bad_response", 502),
    ],
)
async def test_permanent_errors_do_not_retry_or_expose_secrets(
    provider, status, code, http_status, caplog
):
    p, responses, calls = provider
    responses.append(httpx.Response(status, text="mock-private-key"))
    with pytest.raises(ProviderError) as error:
        await p.lookup_by_id("x")
    assert len(calls) == 1
    assert "mock-private-key" not in str(error.value) + caplog.text
    assert (error.value.status_code, error.value.code) == (http_status, code)
    assert error.value.detail["code"] == code and error.value.detail["message"]
    assert error.value.retry_after is None and not error.value.headers


async def test_missing_key_no_request(provider, monkeypatch):
    p, _, calls = provider
    monkeypatch.setattr(settings, "semantic_scholar_api_key", SecretStr(""))
    with pytest.raises(ProviderError) as error:
        await p.lookup_by_id("x")
    assert error.value.code == "provider_not_configured" and error.value.status_code == 503
    assert "SEMANTIC_SCHOLAR_API_KEY" in error.value.detail["message"]
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
        assert (error.value.status_code, error.value.code) == (502, "provider_bad_response")
    # Semantic Scholar's 429s carry no Retry-After: a default one is sent.
    responses.extend([httpx.Response(429)] * 3)
    with pytest.raises(ProviderError) as error:
        await p.lookup_by_id("busy")
    assert (error.value.status_code, error.value.code) == (503, "provider_rate_limited")
    assert error.value.headers["Retry-After"] == str(DEFAULT_RETRY_AFTER)
    assert error.value.detail["retry_after"] == error.value.retry_after == DEFAULT_RETRY_AFTER
    assert len(calls) == 6
    responses.extend([httpx.Response(503)] * 3)
    with pytest.raises(ProviderError) as error:
        await p.lookup_by_id("down")
    assert (error.value.code, error.value.retry_after) == ("provider_unavailable", 30)
    responses.extend([httpx.ConnectError("private error")] * 3)
    with pytest.raises(ProviderError) as error:
        await p.lookup_by_id("offline")
    assert (error.value.code, error.value.retry_after) == ("provider_unavailable", None)
    assert len(calls) == 12


async def test_long_retry_after_is_not_retried_early(provider):
    p, responses, calls = provider
    responses.append(httpx.Response(429, headers={"Retry-After": "120"}))
    with pytest.raises(ProviderError) as error:
        await p.lookup_by_id("x")
    assert error.value.headers["Retry-After"] == "120" and len(calls) == 1
    assert error.value.code == "provider_rate_limited"


async def test_rate_limit_retries_fit_the_resolve_budget(provider):
    p, _, _ = provider
    # Real waits of a lookup answered by three header-less 429s: two backoffs
    # plus pacing before each call must end before the resolve budget does.
    backoff = sum(_retry_delay(httpx.Response(429), attempt) for attempt in range(2))
    pacing = 3 * p._limiter._min_interval
    budget = Settings.model_fields["doi_resolve_timeout_seconds"].default
    assert backoff + pacing < budget


async def test_provider_errors_reach_clients_with_code_and_retry_after(provider, db):
    _p, responses, _calls = provider
    responses.extend([httpx.Response(429)] * 3)
    app = create_app()

    async def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as api:
        busy = await api.get("/api/v1/papers/search", params={"q": "Titans"})
    assert busy.status_code == 503
    assert busy.headers["Retry-After"] == str(DEFAULT_RETRY_AFTER)
    assert busy.json()["detail"]["code"] == "provider_rate_limited"
    assert busy.json()["detail"]["retry_after"] == DEFAULT_RETRY_AFTER


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


async def test_pmcid_alias_finds_the_cached_record(db):
    # Semantic Scholar sends the bare number; the stored value is the key form.
    raw = {**TITANS, "externalIds": {**TITANS["externalIds"], "PubMedCentral": "2323736"}}
    await service.cache_papers(db, [map_paper(raw)])
    row = await service.get_cached_paper(db, "pmcid:PMC2323736")
    assert row is not None and row.semantic_scholar_id == TITANS["paperId"]


async def test_real_api_service_pipeline(provider, db):
    _p, responses, calls = provider
    responses.append({"data": [TITANS, TITANS], "total": 2})
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
    assert set(registry._instances) == {"semantic_scholar"}


@pytest.mark.skip(reason="integration: ported in WP3")
async def test_real_api_graph_pipeline(provider, db):
    _p, responses, _calls = provider
    responses.extend(
        [
            {"data": [{"citingPaper": {"paperId": "citer", "title": "Citer", "year": 2026}}]},
            {"data": [{"citedPaper": {"paperId": "citer"}}]},
            {"data": []},
        ]
    )
    stored = (await service.cache_papers(db, [map_paper(TITANS)]))[0]
    paper = {"canonical_key": stored.canonical_key}
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


@pytest.mark.skip(reason="integration: ported in WP3")
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
        assert error.status_code == 503
        assert error.json()["detail"]["code"] == "provider_not_configured"
        assert "SEMANTIC_SCHOLAR_API_KEY" in error.json()["detail"]["message"]
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


@pytest.mark.parametrize(
    ("next_offset", "page", "author", "expected"),
    [
        (20, 1, None, True),
        (20, 1, "no matching author", True),
        (None, 1, None, False),
        (1000, 50, None, False),
    ],
)
async def test_search_continuation_survives_filtering_and_respects_limit(
    provider, next_offset, page, author, expected
):
    client, responses, _ = provider
    responses.append({"data": [TITANS, TITANS], "total": 10000, "next": next_offset})
    result = await client.search("Titans", SearchFilters(author=author), page=page, size=20)
    assert result.has_more is expected
    merged = service.round_robin_dedupe([result])
    assert service.build_search_response(merged)["has_more"] is expected
    if author:
        assert not result.papers


@pytest.mark.parametrize(
    ("page", "rows", "total", "next_offset", "has_more", "capped"),
    [
        (1, 20, 5000, 20, True, False),
        (50, 19, 5000, 999, False, True),
        (50, 19, 5000, None, False, True),
        (2, 5, 25, None, False, False),
    ],
)
async def test_search_window_and_total_estimate(
    provider, page, rows, total, next_offset, has_more, capped
):
    client, responses, _ = provider
    data = [{**TITANS, "paperId": f"{i:040x}", "externalIds": {}} for i in range(rows)]
    responses.append({"data": data, "total": total, "next": next_offset})
    result = await client.search("Titans", SearchFilters(), page=page, size=20)
    assert (result.has_more, result.window_capped) == (has_more, capped)
    assert result.total_estimate == total


async def test_upstream_window_error_is_coded(provider):
    client, responses, _ = provider
    error = "Relevance search offset + limit must be < 1000. Consider '/paper/search/bulk'"
    responses.append(httpx.Response(400, json={"error": error}))
    with pytest.raises(ProviderError) as raised:
        await client.search("q", SearchFilters(), page=2)
    assert (raised.value.status_code, raised.value.code) == (422, "search_window_exceeded")


def _batch_row(n: int, **extra) -> dict:
    return {"paperId": f"{n:040x}", "title": f"Paper {n}", **extra}


async def test_lookup_many_batches_by_500_in_input_order(s2_mock):
    def answer(request):
        ids = json.loads(request.content)["ids"]
        assert request.method == "POST" and request.url.path.endswith("/paper/batch")
        assert request.url.params["fields"] == PAPER_FIELDS
        # Every third id is unknown (null); one record is incomplete.
        return httpx.Response(
            200,
            json=[
                None
                if int(i.removeprefix("DOI:10.1/")) % 3 == 0
                else {"paperId": None}
                if i == "DOI:10.1/7"
                else _batch_row(int(i.removeprefix("DOI:10.1/")))
                for i in ids
            ],
        )

    s2_mock.handler = answer
    ids = [f"doi:10.1/{n}" for n in range(1, 502)]
    papers = await registry.papers_by_ids(ids)
    assert [len(json.loads(c.content)["ids"]) for c in s2_mock.calls] == [500, 1]
    assert len(papers) == 501
    assert papers[0].title == "Paper 1" and papers[2] is None and papers[6] is None
    assert papers[499].semantic_scholar_id == f"{500:040x}" and papers[500] is None
    assert await registry.papers_by_ids([]) == [] and len(s2_mock.calls) == 2


@pytest.mark.parametrize("body", [{"data": []}, [None], [None, None, None], ["x", None]])
async def test_lookup_many_rejects_malformed_batches(s2_mock, body):
    s2_mock.responses.append(body)
    with pytest.raises(ProviderError) as error:
        await s2_mock.provider.lookup_many(["a", "b"])
    assert error.value.code == "provider_bad_response"


async def test_batch_ids_use_provider_identifier_forms(s2_mock):
    s2_mock.responses.append([None] * 5)
    await s2_mock.provider.lookup_many(
        ["s2:ABC", "doi:https://doi.org/10.1/X", "arxiv:2501.00663v2", "pmid:1", "pmcid:PMC9"]
    )
    assert json.loads(s2_mock.calls[0].content)["ids"] == [
        "ABC",
        "DOI:10.1/x",
        "ARXIV:2501.00663",
        "PMID:1",
        "PMCID:9",
    ]


async def test_references_batch_skips_misses_and_unresolved_references(s2_mock):
    s2_mock.responses.append(
        [
            {"paperId": "a", "references": [{"paperId": "Z"}, {"paperId": None}, {"paperId": "z"}]},
            None,
            {"paperId": "c", "references": None},
        ]
    )
    refs = await registry.references_batch(["a", "b", "c", "a", ""])
    call = s2_mock.calls[0]
    assert call.url.params["fields"] == "paperId,references.paperId"
    assert json.loads(call.content)["ids"] == ["a", "b", "c"]
    assert refs == {"a": ["z"], "c": []}
    assert await registry.references_batch([]) == {} and len(s2_mock.calls) == 1


async def test_sorted_search_uses_bulk_with_a_plain_query_and_token(s2_mock):
    s2_mock.responses.extend(
        [
            {"data": [TITANS, TITANS], "total": 3768, "token": "next-batch"},
            {"data": [], "total": 3768, "token": None},
        ]
    )
    filters = SearchFilters(year_from=2019, year_to=2021, open_access_only=True)
    first = await registry.search_sorted('"graph" +neural -nets (gnn|x)*~', filters, "citations")
    params = s2_mock.calls[0].url.params
    assert s2_mock.calls[0].url.path.endswith("/paper/search/bulk")
    assert params["query"] == "graph neural nets gnn x"
    assert (params["sort"], params["fields"]) == ("citationCount:desc", PAPER_FIELDS)
    assert (params["year"], params["openAccessPdf"]) == ("2019-2021", "")
    assert "token" not in params and "publicationDateOrYear" not in params
    assert (len(first.items), first.total, first.token) == (1, 3768, "next-batch")
    assert first.items[0].semantic_scholar_id == TITANS["paperId"]
    last = await registry.search_sorted("graph", filters, "citations", token=first.token)
    assert s2_mock.calls[1].url.params["token"] == "next-batch"
    assert (last.items, last.token) == ([], None)


async def test_date_sorted_search_ends_today(s2_mock):
    from datetime import UTC, datetime

    today = datetime.now(UTC).date().isoformat()
    s2_mock.responses.extend([{"data": [], "total": 0}] * 3)
    await registry.search_sorted("graph", SearchFilters(), "date")
    await registry.search_sorted("graph", SearchFilters(year_from=2019, year_to=2020), "date")
    await registry.search_sorted("graph", SearchFilters(year_to=9999), "date")
    ranges = [c.url.params["publicationDateOrYear"] for c in s2_mock.calls]
    assert ranges == [f":{today}", "2019-01-01:2020-12-31", f":{today}"]
    assert all(c.url.params["sort"] == "publicationDate:desc" for c in s2_mock.calls)
    assert all("year" not in c.url.params for c in s2_mock.calls)
    # A range starting after today is empty without an inverted upstream range.
    future = SearchFilters(year_from=datetime.now(UTC).year + 1)
    page = await registry.search_sorted("graph", future, "date")
    assert (page.items, page.total, page.token) == ([], 0, None)
    assert len(s2_mock.calls) == 3


async def test_incomplete_rows_are_dropped_from_search_pages(s2_mock):
    untitled = {"paperId": "f" * 40, "title": None}
    s2_mock.responses.extend(
        [
            {"data": [TITANS, untitled, "x"], "total": 3, "token": "more"},
            {"data": [untitled, TITANS], "total": 2, "next": 2},
        ]
    )
    bulk = await s2_mock.provider.search_bulk("titans", SearchFilters(), "citationCount:desc")
    assert [p.semantic_scholar_id for p in bulk.items] == [TITANS["paperId"]]
    assert (bulk.total, bulk.token) == (3, "more")
    ranked = await s2_mock.provider.search("titans", SearchFilters(), size=2)
    assert [p.semantic_scholar_id for p in ranked.papers] == [TITANS["paperId"]]
    assert ranked.has_more


@pytest.mark.parametrize(
    ("query", "sort", "filters"),
    [
        ("+-*()", "citationCount:desc", SearchFilters()),
        ("graph", "relevance", SearchFilters()),
        ("graph", "citationCount:desc", SearchFilters(year_from=2021, year_to=2020)),
    ],
)
async def test_invalid_bulk_queries_fail_before_any_request(s2_mock, query, sort, filters):
    with pytest.raises(ProviderError) as error:
        await s2_mock.provider.search_bulk(query, filters, sort)
    assert (error.value.status_code, error.value.code) == (422, "invalid_query")
    assert s2_mock.calls == []


@pytest.mark.parametrize("body", [{"data": None}, {"data": [], "token": 5}])
async def test_bulk_search_rejects_malformed_pages(s2_mock, body):
    s2_mock.responses.append(body)
    with pytest.raises(ProviderError) as error:
        await s2_mock.provider.search_bulk("graph", SearchFilters(), "citationCount:desc")
    assert error.value.code == "provider_bad_response"


def test_search_cache_version_is_separate_from_the_namespace():
    assert registry.SEARCH_CACHE_VERSION == "v4"
    assert registry.SEARCH_CACHE_VERSION not in registry.CACHE_NAMESPACE
