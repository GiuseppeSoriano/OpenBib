"""OpenAlex related-works paging and id hydration (HTTP mocked with respx)."""

import httpx
import pytest
import respx
from httpx import Response

from app.providers import registry
from app.providers.openalex import (
    OpenAlexProvider,
    RelatedPage,
    _map_work,
    _related_entry,
    _work_keys,
)

WORKS = "https://api.openalex.org/works"
SELECT = "id,doi,title,authorships,publication_year,publication_date,cited_by_count"


def _work(n: int, **extra) -> dict:
    return {
        "id": f"https://openalex.org/W{n}",
        "doi": f"https://doi.org/10.1/w{n}",
        "title": f"Work {n}",
        "authorships": [{"author": {"display_name": "Ada Lovelace"}}],
        "publication_year": 2020,
        "publication_date": "2020-05-01",
        "cited_by_count": 100 - n,
        **extra,
    }


@pytest.fixture
def provider():
    return OpenAlexProvider()


@pytest.mark.asyncio
@respx.mock
async def test_related_page_sends_cursor_paging_params_and_parses_meta(provider):
    route = respx.get(WORKS).mock(
        return_value=Response(
            200,
            json={
                "meta": {"count": 9742, "next_cursor": "c2"},
                "results": [_work(1), _work(2)],
            },
        )
    )

    page = await provider.related_page(
        "https://openalex.org/W2116341502", filter_key="cites", sort="cited_by_count:desc"
    )

    params = route.calls.last.request.url.params
    assert params["filter"] == "cites:W2116341502"
    assert params["sort"] == "cited_by_count:desc"
    assert params["per_page"] == "200"
    assert params["cursor"] == "*"
    assert params["select"] == SELECT
    assert page.count == 9742
    assert page.next_cursor == "c2"
    assert page.entries == [
        ["W1", "doi:10.1/w1", _work_keys(_work(1))[1], "Work 1", 99, "2020-05-01"],
        ["W2", "doi:10.1/w2", _work_keys(_work(2))[1], "Work 2", 98, "2020-05-01"],
    ]


@pytest.mark.asyncio
@respx.mock
async def test_related_page_forwards_the_cursor_and_ends_on_null(provider):
    route = respx.get(WORKS).mock(
        return_value=Response(200, json={"meta": {"count": 3, "next_cursor": None}, "results": []})
    )

    page = await provider.related_page("W9", filter_key="cited_by", sort="x", cursor="abc")

    assert route.calls.last.request.url.params["cursor"] == "abc"
    assert route.calls.last.request.url.params["filter"] == "cited_by:W9"
    assert page == RelatedPage([], 3, None)


@pytest.mark.asyncio
@respx.mock
async def test_related_page_404_is_an_empty_finished_list(provider):
    respx.get(WORKS).mock(return_value=Response(404))

    assert await provider.related_page("W1", filter_key="cites", sort="x") == RelatedPage(
        [], 0, None
    )


@pytest.mark.asyncio
@respx.mock
async def test_related_page_raises_on_server_errors(provider):
    respx.get(WORKS).mock(return_value=Response(503))

    with pytest.raises(httpx.HTTPStatusError):
        await provider.related_page("W1", filter_key="cites", sort="x")


@pytest.mark.asyncio
@respx.mock
async def test_related_page_raises_on_timeouts(provider):
    respx.get(WORKS).mock(side_effect=httpx.ReadTimeout("slow"))

    with pytest.raises(httpx.TimeoutException):
        await provider.related_page("W1", filter_key="cites", sort="x")


@pytest.mark.asyncio
@respx.mock
async def test_registry_maps_direction_and_order_to_openalex(monkeypatch):
    monkeypatch.setattr(registry, "_openalex", OpenAlexProvider())
    route = respx.get(WORKS).mock(
        return_value=Response(200, json={"meta": {"count": 0, "next_cursor": None}, "results": []})
    )

    await registry.related_page("W1", direction="cited_by", order="recent")
    citers = route.calls.last.request.url.params
    await registry.related_page("W1", direction="cites", order="cited_by_count", per_page=50)
    references = route.calls.last.request.url.params

    assert (citers["filter"], citers["sort"]) == ("cites:W1", "publication_date:desc")
    assert (references["filter"], references["sort"]) == ("cited_by:W1", "cited_by_count:desc")
    assert references["per_page"] == "50"


@pytest.mark.asyncio
@respx.mock
async def test_works_by_ids_chunks_by_50_and_keeps_input_order(provider):
    ids = [f"W{n}" for n in range(1, 121)]
    requested: list[list[str]] = []

    def answer(request):
        chunk = request.url.params["filter"].removeprefix("ids.openalex:").split("|")
        requested.append(chunk)
        assert request.url.params["per_page"] == str(len(chunk))
        # Out of order, and W7 no longer exists (merged away).
        results = [_work(int(i[1:])) for i in reversed(chunk) if i != "W7"]
        return Response(200, json={"meta": {"count": len(results)}, "results": results})

    respx.get(WORKS).mock(side_effect=answer)

    papers = await provider.works_by_ids([f"https://openalex.org/{i}" for i in ids])

    assert [len(chunk) for chunk in requested] == [50, 50, 20]
    assert [p.openalex_id for p in papers] == [
        f"https://openalex.org/{i}" for i in ids if i != "W7"
    ]
    assert papers[0].canonical_key == "doi:10.1/w1"


@pytest.mark.asyncio
@respx.mock
async def test_works_by_ids_raises_on_errors(provider):
    respx.get(WORKS).mock(return_value=Response(500))

    with pytest.raises(httpx.HTTPStatusError):
        await provider.works_by_ids(["W1"])


@pytest.mark.parametrize(
    "raw",
    [
        _work(1),
        _work(2, doi=None),
        _work(3, doi=None, publication_year=None),
        _work(
            4,
            doi=None,
            title="Réseaux de neurones: ÉTUDE — über Graphen",
            authorships=[
                {"author": {"display_name": "José  Müller"}},
                {"author": {"display_name": "Zoë O'Brien"}},
                {"author": {}},
            ],
        ),
        _work(5, doi="https://doi.org/10.1000/ABC%2Fdef", authorships=[]),
    ],
)
def test_work_keys_match_map_work(raw):
    paper = _map_work(raw)

    assert _work_keys(raw) == (paper.canonical_key, paper.paper_group_key)
    entry = _related_entry(raw)
    assert entry[1:3] == [paper.canonical_key, paper.paper_group_key]


def test_related_entry_is_compact_and_bounded():
    entry = _related_entry(_work(8, title="x" * 400, cited_by_count=None))

    assert entry[0] == "W8"
    assert len(entry[3]) == 300
    assert entry[4] is None
    assert _related_entry(_work(9, title=None))[3] == ""
