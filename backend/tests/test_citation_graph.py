"""Tests for the live citation pipeline — base graphs.

The provider registry is monkeypatched (no live HTTP). Edges are
``cited_by``, directed citing → cited. Related-paper ranges and top-ups are
covered by ``test_graph_related*.py``.
"""

import asyncio

import pytest
from sqlalchemy import select

from app.graph import service as graph_service
from app.graph.models import PaperGraphEdge
from app.papers.models import CachedPaperMetadata
from app.providers import registry
from app.providers.base import PaperMetadata
from app.providers.semantic_scholar import ProviderError


def _cached(
    key: str, group: str, title: str, semantic_scholar_id: str | None = None, **extra
) -> CachedPaperMetadata:
    return CachedPaperMetadata(
        canonical_key=key,
        paper_group_key=group,
        title=title,
        authors_json=[],
        topics_json=[],
        keywords_json=[],
        semantic_scholar_id=semantic_scholar_id,
        provider_source="semantic_scholar",
        **extra,
    )


class FakeReferences:
    """``registry.references_batch`` and ``get_reference_ids`` with call logs."""

    def __init__(self, refs: dict[str, list[str]]):
        self.refs = refs
        self.batches: list[list[str]] = []
        self.singles: list[str] = []
        self.batch_error: Exception | None = None
        self.slow: set[str] = set()

    async def references_batch(self, ids):
        self.batches.append(list(ids))
        if self.batch_error:
            raise self.batch_error
        return {i: self.refs[i] for i in ids if i in self.refs}

    async def get_reference_ids(self, graph_id):
        self.singles.append(graph_id)
        if graph_id in self.slow:
            await asyncio.sleep(5)
        return self.refs.get(graph_id, [])


@pytest.fixture
def references(monkeypatch):
    fake = FakeReferences({"wa": ["wb", "outside"], "wb": []})
    monkeypatch.setattr(registry, "references_batch", fake.references_batch)
    monkeypatch.setattr(registry, "get_reference_ids", fake.get_reference_ids)
    return fake


@pytest.fixture
async def two_seeds(db):
    db.add_all(
        [
            _cached("doi:10.1/a", "group:a", "Paper A", semantic_scholar_id="wa"),
            _cached("doi:10.1/b", "group:b", "Paper B", semantic_scholar_id="wb"),
        ]
    )
    await db.flush()


def _edges(res) -> set[tuple[str, str, str]]:
    return {(e.source, e.target, e.relation_type) for e in res.edges}


async def test_base_graph_links_intra_set_via_batched_references(
    db, redis_backend, references, two_seeds
):
    res = await graph_service.build_base_graph(db, redis_backend, ["doi:10.1/a", "doi:10.1/b"])

    assert {n.id for n in res.nodes} == {"group:a", "group:b"}
    # A cites B; B cites nothing in the set.
    assert _edges(res) == {("group:a", "group:b", "cited_by")}
    assert res.edges_partial is False
    assert references.batches == [["wa", "wb"]] and references.singles == []
    rows = (await db.execute(select(PaperGraphEdge))).scalars().all()
    assert {(r.source_key, r.target_key, r.provider_source) for r in rows} == {
        ("doi:10.1/a", "doi:10.1/b", "semantic_scholar")
    }

    # Reference ids are cached: the next open makes no provider call.
    again = await graph_service.build_base_graph(db, redis_backend, ["doi:10.1/a", "doi:10.1/b"])
    assert _edges(again) == _edges(res)
    assert references.batches == [["wa", "wb"]]


async def test_seeds_without_a_paper_id_are_resolved_in_one_batch(
    db, redis_backend, references, monkeypatch
):
    db.add_all(
        [
            _cached("doi:10.1/a", "group:a", "Paper A", doi="10.1/a"),
            _cached("doi:10.1/b", "group:b", "Paper B", semantic_scholar_id="wb"),
            _cached("hash:c", "group:c", "Paper C"),
        ]
    )
    await db.flush()
    lookups: list[list[str]] = []

    async def papers_by_ids(ids):
        lookups.append(list(ids))
        return [
            PaperMetadata(
                canonical_key="doi:10.1/a",
                paper_group_key="group:s2-a",
                title="Paper A",
                doi="10.1/a",
                semantic_scholar_id="wa",
                provider_source="semantic_scholar",
            )
        ]

    monkeypatch.setattr(registry, "papers_by_ids", papers_by_ids)

    res = await graph_service.build_base_graph(
        db, redis_backend, ["doi:10.1/a", "doi:10.1/b", "hash:c"]
    )

    # hash: keys have nothing to look up by.
    assert lookups == [["DOI:10.1/a"]]
    assert _edges(res) == {("group:a", "group:b", "cited_by")}
    row = await db.get(CachedPaperMetadata, "doi:10.1/a")
    assert (row.semantic_scholar_id, row.paper_group_key) == ("wa", "group:a")
    assert res.edges_partial is False


async def test_references_fall_back_to_seed_by_seed_within_the_budget(
    db, redis_backend, references, two_seeds, monkeypatch
):
    monkeypatch.setattr(graph_service, "_EDGE_BUDGET_SECONDS", 0.3)
    references.batch_error = ProviderError("provider_bad_response", "odd", 502)
    references.slow.add("wb")

    res = await graph_service.build_base_graph(db, redis_backend, ["doi:10.1/a", "doi:10.1/b"])

    assert references.singles == ["wa", "wb"]
    # A's references arrived in time; B's did not, so edges may be missing.
    assert _edges(res) == {("group:a", "group:b", "cited_by")}
    assert res.edges_partial is True
    assert len(res.nodes) == 2


async def test_a_failed_seed_lookup_reports_partial_edges(
    db, redis_backend, references, monkeypatch
):
    db.add_all(
        [
            _cached("doi:10.1/a", "group:a", "Paper A", doi="10.1/a"),
            _cached("doi:10.1/b", "group:b", "Paper B", semantic_scholar_id="wb"),
        ]
    )
    await db.flush()

    async def rate_limited(_ids):
        raise ProviderError("provider_rate_limited", "busy", retry_after=30)

    monkeypatch.setattr(registry, "papers_by_ids", rate_limited)

    res = await graph_service.build_base_graph(db, redis_backend, ["doi:10.1/a", "doi:10.1/b"])

    assert (len(res.nodes), res.edges, res.edges_partial) == (2, [], True)
    # The rate limit will not clear within the request: no reference calls.
    assert references.batches == references.singles == []


async def test_a_batch_rejected_for_one_unreadable_id_is_split(
    db, redis_backend, references, monkeypatch
):
    db.add_all(
        [
            _cached("doi:10.1/a", "group:a", "Paper A", doi="10.1/a"),
            _cached("doi:10.1/b", "group:b", "Paper B", semantic_scholar_id="wb"),
            _cached("doi:10.1/bad", "group:bad", "Legacy", doi="10.1/bad"),
            _cached("doi:10.1/c", "group:c", "Paper C", doi="10.1/c"),
        ]
    )
    await db.flush()
    references.refs = {"wa": ["wb"], "wb": [], "wc": ["wa"]}
    lookups: list[list[str]] = []

    async def papers_by_ids(ids):
        lookups.append(list(ids))
        if "DOI:10.1/bad" in ids:
            raise ProviderError("invalid_query", "unreadable", 422)
        return [
            PaperMetadata(
                canonical_key="doi:" + i.removeprefix("DOI:"),
                paper_group_key="group:s2-" + i,
                title="Found",
                doi=i.removeprefix("DOI:"),
                semantic_scholar_id="w" + i.removeprefix("DOI:10.1/"),
                provider_source="semantic_scholar",
            )
            for i in ids
        ]

    monkeypatch.setattr(registry, "papers_by_ids", papers_by_ids)

    res = await graph_service.build_base_graph(
        db, redis_backend, ["doi:10.1/a", "doi:10.1/b", "doi:10.1/bad", "doi:10.1/c"]
    )

    a, bad, c = "DOI:10.1/a", "DOI:10.1/bad", "DOI:10.1/c"
    assert lookups == [[a, bad, c], [a], [bad, c], [bad], [c]]
    assert _edges(res) == {("group:a", "group:b", "cited_by"), ("group:c", "group:a", "cited_by")}
    # An identifier Semantic Scholar cannot read is not an outage.
    assert res.edges_partial is False
    assert (await db.get(CachedPaperMetadata, "doi:10.1/c")).semantic_scholar_id == "wc"


@pytest.mark.parametrize(
    "code", ["provider_rate_limited", "provider_not_configured", "provider_key_rejected"]
)
async def test_references_are_not_fetched_seed_by_seed_after_a_rate_limit(
    db, redis_backend, references, two_seeds, code
):
    references.batch_error = ProviderError(code, "no", retry_after=30)

    res = await graph_service.build_base_graph(db, redis_backend, ["doi:10.1/a", "doi:10.1/b"])

    assert references.singles == []
    assert (res.edges, res.edges_partial) == ([], True)


async def test_a_single_seed_graph_calls_no_reference_provider(db, redis_backend, references):
    db.add(_cached("doi:10.1/a", "group:a", "Paper A", semantic_scholar_id="wa"))
    await db.flush()

    res = await graph_service.build_base_graph(db, redis_backend, ["doi:10.1/a"])

    assert [n.id for n in res.nodes] == ["group:a"]
    assert references.batches == references.singles == []


@pytest.mark.parametrize(
    "key", ["doi:10.1/x", "s2:abc123", "arxiv:2501.00663", "pmid:123", "pmcid:PMC456"]
)
async def test_an_uncached_single_seed_is_resolved_by_any_strong_key(
    db, redis_backend, monkeypatch, key
):
    calls: list[tuple] = []
    paper = PaperMetadata(
        canonical_key="doi:10.1/x",
        paper_group_key="group:x",
        title="Resolved",
        doi="10.1/x",
        semantic_scholar_id="abc123",
        provider_source="semantic_scholar",
    )

    async def resolve_doi(doi, *, confirm_missing=True):
        calls.append(("doi", doi, confirm_missing))
        return registry.DoiLookup("found", paper)

    async def resolve_id(identifier):
        calls.append(("id", identifier))
        return registry.DoiLookup("found", paper)

    monkeypatch.setattr(registry, "resolve_doi", resolve_doi)
    monkeypatch.setattr(registry, "resolve_id", resolve_id)

    res = await graph_service.build_base_graph(db, redis_backend, [key])

    # A graph needs the record only: no doi.org check for a missing DOI.
    assert calls == ([("doi", "10.1/x", False)] if key.startswith("doi:") else [("id", key)])
    assert (res.active_paper_key, res.nodes[0].label) == ("doi:10.1/x", "Resolved")
    assert (await db.get(CachedPaperMetadata, "doi:10.1/x")).semantic_scholar_id == "abc123"


async def test_an_unresolvable_single_seed_keeps_its_key(db, redis_backend, monkeypatch):
    async def unavailable(_identifier):
        return registry.DoiLookup("unavailable", retry_after=30)

    monkeypatch.setattr(registry, "resolve_id", unavailable)

    missing = await graph_service.build_base_graph(db, redis_backend, ["s2:gone"])
    local = await graph_service.build_base_graph(db, redis_backend, ["hash:local"])

    assert (missing.active_paper_key, missing.nodes[0].label) == ("s2:gone", "s2:gone")
    assert local.active_paper_key == "hash:local"
