"""Tests for the live citation pipeline — base graphs + one-level expansion.

The provider registry is monkeypatched (no live HTTP) and ``redis=None`` so the
service skips its cache. Edges are ``cited_by``, directed citing → cited.
"""

import pytest
from sqlalchemy import select

from app.graph import service as graph_service
from app.graph.models import PaperGraphEdge
from app.papers.models import CachedPaperMetadata
from app.providers import base as provider_base
from app.providers import registry


def _cached(
    key: str, group: str, title: str, semantic_scholar_id: str | None = None
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
    )


def _meta(
    key: str,
    group: str,
    title: str,
    semantic_scholar_id: str | None = None,
    cited_by_count: int | None = None,
) -> provider_base.PaperMetadata:
    return provider_base.PaperMetadata(
        canonical_key=key,
        paper_group_key=group,
        title=title,
        semantic_scholar_id=semantic_scholar_id,
        cited_by_count=cited_by_count,
        provider_source="semantic_scholar",
    )


@pytest.mark.asyncio
async def test_expand_adds_only_new_leaves_and_cited_by_direction(db, monkeypatch):
    db.add(_cached("doi:seed", "group:seed", "Seed", semantic_scholar_id="W1"))
    await db.flush()

    citers = [
        _meta("doi:c1", "group:c1", "Citer One", "W2", cited_by_count=10),
        _meta("doi:c2", "group:c2", "Citer Two", "W3", cited_by_count=5),
    ]

    async def fake_list(semantic_scholar_id, *, order="cited_by_count", limit=25):
        return citers

    monkeypatch.setattr(registry, "list_citing_papers", fake_list)

    res = await graph_service.expand_graph(
        db,
        None,
        from_keys=["doi:seed"],
        existing_group_keys=["group:seed"],
    )

    # Both citers become new leaves; every edge points citing -> cited(seed).
    assert {n.id for n in res.nodes} == {"group:c1", "group:c2"}
    assert all(e.target == "group:seed" and e.relation_type == "cited_by" for e in res.edges)
    assert {e.source for e in res.edges} == {"group:c1", "group:c2"}
    # cited_by_count carried through for node sizing.
    assert next(n for n in res.nodes if n.id == "group:c1").selected_version.cited_by_count == 10

    # A citer already on screen is not re-added, but its edge still appears.
    res2 = await graph_service.expand_graph(
        db,
        None,
        from_keys=["doi:seed"],
        existing_group_keys=["group:seed", "group:c1"],
    )
    assert {n.id for n in res2.nodes} == {"group:c2"}
    assert {(e.source, e.target) for e in res2.edges} == {
        ("group:c1", "group:seed"),
        ("group:c2", "group:seed"),
    }


@pytest.mark.asyncio
async def test_expand_persists_edges_only_between_saved_papers(db, monkeypatch):
    db.add(_cached("doi:seed", "group:seed", "Seed", semantic_scholar_id="W1"))
    await db.flush()

    citers = [
        _meta("doi:c1", "group:c1", "Citer One", "W2"),
        _meta("doi:c2", "group:c2", "Citer Two", "W3"),
    ]

    async def fake_list(semantic_scholar_id, *, order="cited_by_count", limit=25):
        return citers

    monkeypatch.setattr(registry, "list_citing_papers", fake_list)

    await graph_service.expand_graph(
        db,
        None,
        from_keys=["doi:seed"],
        existing_group_keys=["group:seed"],
        saved_keys={"doi:seed", "doi:c1"},  # c2 is not saved
    )

    rows = (await db.execute(select(PaperGraphEdge))).scalars().all()
    stored = {(r.source_key, r.target_key, r.relation_type) for r in rows}
    assert stored == {("doi:c1", "doi:seed", "cited_by")}


@pytest.mark.asyncio
async def test_base_graph_links_intra_set_via_references(db, monkeypatch):
    db.add_all(
        [
            _cached("doi:a", "group:a", "Paper A", semantic_scholar_id="WA"),
            _cached("doi:b", "group:b", "Paper B", semantic_scholar_id="WB"),
        ]
    )
    await db.flush()

    async def fake_refs(semantic_scholar_id):
        # A references B (A cites B); B references nothing in the set.
        return {
            "WA": ["WB"],
            "WB": [],
        }.get(semantic_scholar_id, [])

    monkeypatch.setattr(registry, "get_reference_ids", fake_refs)

    res = await graph_service.build_base_graph(db, None, ["doi:a", "doi:b"])

    assert {n.id for n in res.nodes} == {"group:a", "group:b"}
    assert {(e.source, e.target, e.relation_type) for e in res.edges} == {
        ("group:a", "group:b", "cited_by")
    }

    rows = (await db.execute(select(PaperGraphEdge))).scalars().all()
    assert {(r.source_key, r.target_key) for r in rows} == {("doi:a", "doi:b")}


@pytest.mark.asyncio
async def test_expand_cites_direction_orients_edges_seed_to_reference(db, monkeypatch):
    db.add(_cached("doi:seed", "group:seed", "Seed", semantic_scholar_id="W1"))
    await db.flush()

    refs = [_meta("doi:r1", "group:r1", "Reference One", "W9", cited_by_count=99)]

    async def fake_refs(semantic_scholar_id, *, order="cited_by_count", limit=25):
        return refs

    monkeypatch.setattr(registry, "list_referenced_papers", fake_refs)

    res = await graph_service.expand_graph(
        db,
        None,
        from_keys=["doi:seed"],
        existing_group_keys=["group:seed"],
        direction="cites",
        saved_keys={"doi:seed", "doi:r1"},
    )

    # In "cites" mode the seed is the citer: edge points seed -> reference.
    assert {n.id for n in res.nodes} == {"group:r1"}
    assert {(e.source, e.target, e.relation_type) for e in res.edges} == {
        ("group:seed", "group:r1", "cited_by")
    }

    rows = (await db.execute(select(PaperGraphEdge))).scalars().all()
    assert {(r.source_key, r.target_key) for r in rows} == {("doi:seed", "doi:r1")}
