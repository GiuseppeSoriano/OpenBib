"""API tests for GET /papers/search: grouping, sorts, cursors and validation."""

import base64
import json
from datetime import UTC, date, datetime
from types import SimpleNamespace

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app.common import rate_limit
from app.dependencies import get_db
from app.main import create_app
from app.papers import search, service
from app.providers.base import Author, BulkSearchPage, PaperMetadata, SearchFilters, SearchResult
from app.providers.registry import DoiLookup
from app.providers.semantic_scholar import ProviderError

URL = "/api/v1/papers/search"


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
async def test_search_endpoint_returns_empty_payload_when_nothing_matches(db, monkeypatch):
    async def override_db():
        yield db

    async def fake_search_all(*args, **kwargs):
        return [
            SearchResult(
                papers=[], total_count=0, page=1, page_size=20, provider="semantic_scholar"
            )
        ]

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
    assert payload["has_more"] is False
    assert payload["providers"] == ["semantic_scholar"]


# ── Sorts, cursors, validation ───────────────────────────────


def _make_app(db):
    async def override_db():
        yield db

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    return app


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")


def _ranked(prefix: str, count: int, *, total: int = 0) -> list[PaperMetadata]:
    """``count`` distinct records in provider order (most cited first)."""
    return [
        PaperMetadata(
            canonical_key=f"s2:{prefix}{i}",
            paper_group_key=f"group:{prefix}{i}",
            title=f"Ranked result {prefix}{i}",
            authors=[Author(name=f"Author {prefix}{i}")],
            publication_date=date(2020, 1, 1),
            cited_by_count=total - i,
            provider_source="semantic_scholar",
        )
        for i in range(count)
    ]


def _keys(payload: dict) -> list[str]:
    return [item["paper"]["canonical_key"] for item in payload["items"]]


def _fake_bulk(monkeypatch, batches: dict[str | None, BulkSearchPage]) -> list[tuple]:
    calls: list[tuple] = []

    async def fake_search_sorted(query, filters=None, sort="citations", token=None):
        calls.append((query, filters, sort, token))
        return batches[token]

    monkeypatch.setattr("app.providers.registry.search_sorted", fake_search_sorted)
    return calls


def _fake_relevance(monkeypatch, result: SearchResult) -> list[dict]:
    calls: list[dict] = []

    async def fake_search_all(*args, **kwargs):
        calls.append(kwargs)
        return [result]

    monkeypatch.setattr("app.providers.registry.search_all", fake_search_all)
    return calls


@pytest.mark.asyncio
async def test_citation_sort_serves_bulk_batches_in_cursor_slices(db, monkeypatch):
    calls = _fake_bulk(
        monkeypatch,
        {
            None: BulkSearchPage(items=_ranked("b", 45, total=100), total=3768, token="T2"),
            "T2": BulkSearchPage(items=_ranked("c", 3), total=3768, token=None),
        },
    )
    pages = []
    async with _client(_make_app(db)) as client:
        params = {"q": "graph neural networks", "sort": "citations", "size": 20}
        while True:
            response = await client.get(URL, params=params)
            assert response.status_code == 200
            pages.append(response.json())
            if not pages[-1]["next_cursor"]:
                break
            params = {**params, "cursor": pages[-1]["next_cursor"]}

    assert [_keys(page) for page in pages] == [
        [f"s2:b{i}" for i in range(20)],
        [f"s2:b{i}" for i in range(20, 40)],
        [f"s2:b{i}" for i in range(40, 45)],
        ["s2:c0", "s2:c1", "s2:c2"],
    ]
    assert [page["has_more"] for page in pages] == [True, True, True, False]
    first = pages[0]
    assert first["sort"] == "citations"
    assert first["total_estimate"] == 3768
    assert first["source"] == "semantic_scholar"
    assert first["window_capped"] is False and first["filtered_locally"] is False
    # The cursor is opaque base64 JSON naming the batch token and slice index.
    raw = pages[2]["next_cursor"]
    cursor = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    assert {k: cursor[k] for k in ("v", "sort", "token", "index")} == {
        "v": 1,
        "sort": "citations",
        "token": "T2",
        "index": 0,
    }
    # Each upstream batch is fetched once; later slices come from its cache.
    assert [call[3] for call in calls] == [None, "T2"]


@pytest.mark.asyncio
async def test_sorted_search_forwards_query_filters_and_sort(db, monkeypatch):
    calls = _fake_bulk(monkeypatch, {None: BulkSearchPage(items=[], total=0)})
    params = {
        "q": "odor prediction",
        "sort": "date",
        "year_from": 2019,
        "year_to": 2021,
        "open_access_only": "true",
    }
    async with _client(_make_app(db)) as client:
        response = await client.get(URL, params=params)

    assert response.status_code == 200
    payload = response.json()
    assert payload["items"] == [] and payload["next_cursor"] is None
    assert payload["has_more"] is False and payload["total_estimate"] == 0
    query, filters, sort, token = calls[0]
    assert (query, sort, token) == ("odor prediction", "date", None)
    assert (filters.year_from, filters.year_to, filters.open_access_only) == (2019, 2021, True)


def _cursor(payload: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


def _signed(**overrides) -> str:
    fields = {
        "v": 1,
        "sort": "citations",
        "token": None,
        "index": 20,
        "sig": search.query_signature("graph", SearchFilters(), "citations"),
    }
    return _cursor({**fields, **overrides})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("sort", "cursor"),
    [
        ("citations", "not a cursor!"),
        ("citations", _cursor(["v", 1])),
        ("citations", _signed(v=2)),
        ("citations", _signed(index=-1)),
        ("citations", _signed(index=1000)),
        ("citations", _signed(index="20")),
        ("citations", _signed(token="")),
        ("citations", _signed(sig=search.query_signature("other", SearchFilters(), "citations"))),
        ("date", _signed()),
        ("relevance", _signed(sort="relevance")),
    ],
)
async def test_bad_cursors_are_rejected_before_any_provider_call(db, monkeypatch, sort, cursor):
    calls = _fake_bulk(monkeypatch, {})
    relevance = _fake_relevance(
        monkeypatch, SearchResult(papers=[], total_count=0, page=1, page_size=20, provider="x")
    )
    async with _client(_make_app(db)) as client:
        response = await client.get(URL, params={"q": "graph", "sort": sort, "cursor": cursor})

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_cursor"
    assert calls == [] and relevance == []


@pytest.mark.asyncio
async def test_a_valid_cursor_continues_its_own_query(db, monkeypatch):
    _fake_bulk(monkeypatch, {None: BulkSearchPage(items=_ranked("b", 30), total=30)})
    async with _client(_make_app(db)) as client:
        response = await client.get(
            URL, params={"q": "graph", "sort": "citations", "size": 20, "cursor": _signed()}
        )
    assert response.status_code == 200
    assert _keys(response.json()) == [f"s2:b{i}" for i in range(20, 30)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("year_from", "year_to"),
    [(2021, 2020), (1799, None), (None, "next+1"), ("next+1", None)],
)
async def test_invalid_year_ranges_are_rejected_before_the_cache(
    db, monkeypatch, redis_backend, year_from, year_to
):
    next_year = datetime.now(UTC).year + 1
    years = {"next+1": next_year + 1}
    params = {"q": "graph", "year_from": years.get(year_from, year_from)}
    params["year_to"] = years.get(year_to, year_to)
    reads: list[str] = []
    original_get = redis_backend.get

    async def counting_get(key):
        reads.append(key)
        return await original_get(key)

    monkeypatch.setattr(redis_backend, "get", counting_get)
    relevance = _fake_relevance(
        monkeypatch, SearchResult(papers=[], total_count=0, page=1, page_size=20, provider="x")
    )
    async with _client(_make_app(db)) as client:
        response = await client.get(URL, params={k: v for k, v in params.items() if v})

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "invalid_year_range"
    assert (detail["min_year"], detail["max_year"]) == (1800, next_year)
    assert reads == [] and relevance == []


@pytest.mark.asyncio
async def test_years_up_to_next_year_are_accepted(db, monkeypatch):
    next_year = datetime.now(UTC).year + 1
    calls = _fake_relevance(
        monkeypatch, SearchResult(papers=[], total_count=0, page=1, page_size=20, provider="x")
    )
    async with _client(_make_app(db)) as client:
        response = await client.get(
            URL, params={"q": "graph", "year_from": 1800, "year_to": next_year}
        )
    assert response.status_code == 200
    assert (calls[0]["filters"].year_from, calls[0]["filters"].year_to) == (1800, next_year)


@pytest.mark.asyncio
async def test_relevance_pages_stop_at_the_provider_window(db, monkeypatch):
    duplicate = _ranked("w", 2)
    duplicate[1].canonical_key = duplicate[0].canonical_key
    calls = _fake_relevance(
        monkeypatch,
        SearchResult(
            papers=duplicate,
            total_count=2,
            page=50,
            page_size=20,
            provider="semantic_scholar",
            has_more=False,
            total_estimate=12345,
            window_capped=True,
        ),
    )
    async with _client(_make_app(db)) as client:
        last = await client.get(URL, params={"q": "graph", "page": 50, "size": 20})
        beyond = await client.get(URL, params={"q": "graph", "page": 51, "size": 20})

    assert last.status_code == 200
    payload = last.json()
    assert payload["window_capped"] is True and payload["has_more"] is False
    # The provider's estimate survives deduplication of the served rows.
    assert payload["total_estimate"] == 12345
    assert (payload["raw_total_count"], payload["total_count"]) == (2, 1)
    assert payload["sort"] == "relevance" and payload["next_cursor"] is None
    assert beyond.status_code == 422
    assert beyond.json()["detail"]["code"] == "search_window_exceeded"
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("sort", ["relevance", "citations"])
async def test_provider_errors_reach_the_client_with_code_and_retry_after(db, monkeypatch, sort):
    async def rate_limited(*args, **kwargs):
        raise ProviderError("provider_rate_limited", "Busy.", retry_after=12)

    monkeypatch.setattr("app.providers.registry.search_all", rate_limited)
    monkeypatch.setattr("app.providers.registry.search_sorted", rate_limited)
    async with _client(_make_app(db)) as client:
        response = await client.get(URL, params={"q": "graph", "sort": sort})

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "12"
    assert response.json()["detail"] == {
        "code": "provider_rate_limited",
        "message": "Busy.",
        "retry_after": 12,
    }


def _version(key: str, group: str, title: str, year: int, **ids) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=key,
        paper_group_key=group,
        title=title,
        authors=[Author(name="Zonghan Wu"), Author(name="Shirui Pan")],
        publication_date=date(year, 1, 1),
        provider_source="semantic_scholar",
        **ids,
    )


@pytest.mark.asyncio
async def test_possible_versions_are_flagged_but_never_merged(db, monkeypatch):
    title = "A Comprehensive Survey on Graph Neural Networks"
    papers = [
        _version("s2:" + "a" * 40, "group:pre", title, 2019, semantic_scholar_id="a" * 40),
        _version("s2:" + "f" * 40, "group:other", "Protein folding at scale", 2019),
        _version(
            "doi:10.1109/tnnls.2020.2978386",
            "group:journal",
            f"<i>{title.upper()}</i>",
            2020,
            doi="10.1109/tnnls.2020.2978386",
            semantic_scholar_id="b" * 40,
        ),
    ]
    _fake_relevance(
        monkeypatch,
        SearchResult(papers=papers, total_count=3, page=1, page_size=20, provider="x"),
    )
    async with _client(_make_app(db)) as client:
        response = await client.get(URL, params={"q": "graph neural networks survey"})

    items = response.json()["items"]
    assert [item["paper"]["paper_group_key"] for item in items] == [
        "group:pre",
        "group:other",
        "group:journal",
    ]
    assert items[0]["possible_versions"] == [
        {
            "paper_group_key": "group:journal",
            "title": title.upper(),
            "provider_sources": ["semantic_scholar"],
        }
    ]
    assert items[1]["possible_versions"] == []
    assert [v["paper_group_key"] for v in items[2]["possible_versions"]] == ["group:pre"]


@pytest.mark.asyncio
@pytest.mark.parametrize("sort", ["relevance", "date"])
async def test_author_filter_is_applied_locally_and_reported(db, monkeypatch, sort):
    relevance = _fake_relevance(
        monkeypatch, SearchResult(papers=[], total_count=0, page=1, page_size=20, provider="x")
    )
    bulk = _fake_bulk(monkeypatch, {None: BulkSearchPage(items=[], total=0)})
    async with _client(_make_app(db)) as client:
        filtered = await client.get(URL, params={"q": "graph", "sort": sort, "author": " Wu "})
        unfiltered = await client.get(URL, params={"q": "graph", "sort": sort, "author": " "})

    assert filtered.json()["filtered_locally"] is True
    assert unfiltered.json()["filtered_locally"] is False
    authors = (
        [call["filters"].author for call in relevance]
        if sort == "relevance"
        else [call[1].author for call in bulk]
    )
    assert authors == ["Wu", None]


def _s2_row(index: int) -> dict:
    return {
        "paperId": f"{index:040x}",
        "title": f"Bulk result number {index}",
        "authors": [{"authorId": str(index), "name": f"Author {index}"}],
        "year": 2020,
        "citationCount": 1000 - index,
    }


@pytest.mark.asyncio
async def test_real_adapter_pages_relevance_and_bulk_sorts(db, s2_mock):
    def handler(request: httpx.Request) -> httpx.Response:
        params = request.url.params
        if request.url.path.endswith("/paper/search/bulk"):
            if params.get("token") == "NEXT":
                return httpx.Response(200, json={"total": 23, "data": [_s2_row(22)]})
            rows = [_s2_row(i) for i in range(22)]
            return httpx.Response(200, json={"total": 23, "token": "NEXT", "data": rows})
        offset = int(params["offset"])
        rows = [_s2_row(offset + i) for i in range(int(params["limit"]))]
        return httpx.Response(200, json={"total": 5000, "next": offset + 20, "data": rows})

    s2_mock.handler = handler
    async with _client(_make_app(db)) as client:
        relevance = await client.get(URL, params={"q": "graph", "page": 3, "size": 20})
        first = await client.get(
            URL, params={"q": "graph-nets", "sort": "citations", "size": 20, "year_to": 2021}
        )
        cursor = first.json()["next_cursor"]
        second = await client.get(
            URL,
            params={
                "q": "graph-nets",
                "sort": "citations",
                "size": 20,
                "year_to": 2021,
                "cursor": cursor,
            },
        )
        third = await client.get(
            URL,
            params={
                "q": "graph-nets",
                "sort": "citations",
                "size": 20,
                "year_to": 2021,
                "cursor": second.json()["next_cursor"],
            },
        )

    assert relevance.status_code == 200
    assert relevance.json()["total_estimate"] == 5000 and relevance.json()["has_more"] is True
    search_call = s2_mock.calls[0].url.params
    assert (search_call["offset"], search_call["limit"]) == ("40", "20")
    assert [len(page.json()["items"]) for page in (first, second, third)] == [20, 2, 1]
    assert third.json()["next_cursor"] is None and third.json()["total_estimate"] == 23
    bulk_calls = [call.url.params for call in s2_mock.calls[1:]]
    # The second slice of the first batch needed no upstream call.
    assert len(bulk_calls) == 2
    assert bulk_calls[0]["sort"] == "citationCount:desc"
    assert bulk_calls[0]["query"] == "graph nets" and bulk_calls[0]["year"] == "-2021"
    assert "token" not in bulk_calls[0] and bulk_calls[1]["token"] == "NEXT"


# ── Paper lookup metering (papers router, GET /papers/{key}) ──


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key",
    [
        "doi:10.5/miss",
        "s2:" + "a" * 40,
        "arxiv:2501.00663",
        "pmid:31452104",
        "pmcid:PMC6700000",
        # Unprefixed forms get_paper_detail still resolves live.
        "2501.00663",
        "arxiv.org/abs/2501.00663",
        "www.semanticscholar.org/paper/" + "a" * 40,
    ],
)
async def test_live_lookups_are_metered_for_every_strong_prefix(db, monkeypatch, key):
    # Freeze the bucket clock so slow requests cannot refill tokens mid-test.
    monkeypatch.setattr(rate_limit, "time", SimpleNamespace(time=lambda: 1_700_000_000.0))

    async def missing(*args, **kwargs):
        return DoiLookup("not_found")

    monkeypatch.setattr("app.providers.registry.resolve_doi", missing)
    monkeypatch.setattr("app.providers.registry.resolve_id", missing)
    async with _client(_make_app(db)) as client:
        statuses = [(await client.get(f"/api/v1/papers/{key}")).status_code for _ in range(21)]
        hashes = [(await client.get("/api/v1/papers/hash:nope")).status_code for _ in range(21)]

    assert statuses[:20] == [404] * 20
    assert statuses[20] == 429
    # Keys only the cache can answer are never metered.
    assert hashes == [404] * 21


@pytest.mark.asyncio
async def test_unprefixed_forms_of_cached_papers_are_not_metered(db, monkeypatch):
    monkeypatch.setattr(rate_limit, "time", SimpleNamespace(time=lambda: 1_700_000_000.0))

    async def never(*args, **kwargs):
        raise AssertionError("a cached paper must not be resolved live")

    monkeypatch.setattr("app.providers.registry.resolve_id", never)
    paper = _paper("s2:" + "c" * 40, "group:cached-arxiv", "Cached arXiv paper", None)
    paper.arxiv_id = "2501.00664"
    await service.cache_papers(db, [paper])
    async with _client(_make_app(db)) as client:
        statuses = [
            (await client.get("/api/v1/papers/arxiv.org/abs/2501.00664")).status_code
            for _ in range(25)
        ]

    assert statuses == [200] * 25


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "patched"), [("doi:10.5/busy", "resolve_doi"), ("s2:" + "b" * 40, "resolve_id")]
)
async def test_unavailable_lookups_are_503_with_retry_after(db, monkeypatch, key, patched):
    async def unavailable(*args, **kwargs):
        return DoiLookup("unavailable", retry_after=12)

    monkeypatch.setattr(f"app.providers.registry.{patched}", unavailable)
    async with _client(_make_app(db)) as client:
        response = await client.get(f"/api/v1/papers/{key}")

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "12"
    assert response.json()["detail"]["code"] == "provider_unavailable"
