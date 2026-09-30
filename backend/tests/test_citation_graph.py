"""Tests for the live citation pipeline — base graphs.

The provider registry is monkeypatched (no live HTTP) and ``redis=None`` so the
service skips its cache. Edges are ``cited_by``, directed citing → cited.
Related-paper ranges and top-ups are covered by ``test_graph_related*.py``.
"""

import pytest
from sqlalchemy import select

from app.graph import service as graph_service
from app.graph.models import PaperGraphEdge
from app.papers.models import CachedPaperMetadata
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
