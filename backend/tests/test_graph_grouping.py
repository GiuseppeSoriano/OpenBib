"""Tests for grouped graph neighborhoods."""

from datetime import date

import pytest

from app.graph import service as graph_service
from app.graph.models import PaperGraphEdge
from app.papers.models import CachedPaperMetadata


def make_cached_paper(
    canonical_key: str,
    paper_group_key: str,
    title: str,
    publication_date: date,
    version: str | None = None,
) -> CachedPaperMetadata:
    return CachedPaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=paper_group_key,
        title=title,
        authors_json=[
            {"name": "Alice Smith", "affiliations": [], "openalex_id": None, "orcid": None}
        ],
        publication_date=publication_date,
        topics_json=[],
        keywords_json=[],
        version=version,
        provider_source="openalex",
    )


@pytest.mark.asyncio
async def test_graph_groups_versions_and_switches_selected_version(db):
    db.add_all(
        [
            make_cached_paper("hash:a-v1", "group:a", "Seed Paper", date(2024, 1, 1), "v1"),
            make_cached_paper("hash:a-v2", "group:a", "Seed Paper", date(2025, 1, 1), "v2"),
            make_cached_paper("hash:b-v1", "group:b", "Neighbor Paper", date(2023, 1, 1), "v1"),
            make_cached_paper("hash:b-v2", "group:b", "Neighbor Paper", date(2024, 1, 1), "v2"),
            make_cached_paper("hash:c-v1", "group:c", "Older Neighbor", date(2022, 1, 1), "v1"),
        ]
    )
    db.add_all(
        [
            PaperGraphEdge(
                source_key="hash:a-v2",
                target_key="hash:b-v1",
                relation_type="cites",
                provider_source="openalex",
            ),
            PaperGraphEdge(
                source_key="hash:a-v1",
                target_key="hash:c-v1",
                relation_type="cites",
                provider_source="openalex",
            ),
        ]
    )
    await db.flush()

    grouped = await graph_service.get_neighborhood(db, "hash:a-v2", depth=1, max_nodes=10)

    assert grouped.active_paper_group_key == "group:a"
    assert {node.id for node in grouped.nodes} == {"group:a", "group:b"}
    seed = next(node for node in grouped.nodes if node.id == "group:a")
    assert seed.type == "paper_group"
    assert seed.version_count == 2
    assert seed.selected_version.canonical_key == "hash:a-v2"
    neighbor = next(node for node in grouped.nodes if node.id == "group:b")
    assert neighbor.type == "paper_group"
    assert neighbor.selected_version.canonical_key == "hash:b-v2"
    assert len(grouped.edges) == 1
    assert grouped.edges[0].source == "group:a"
    assert grouped.edges[0].target == "group:b"
    assert grouped.edges[0].relation_type == "cites"

    switched = await graph_service.get_neighborhood(
        db,
        "hash:a-v2",
        depth=1,
        max_nodes=10,
        selected_versions={"group:a": "hash:a-v1"},
    )

    assert {node.id for node in switched.nodes} == {"group:a", "group:c"}
    switched_seed = next(node for node in switched.nodes if node.id == "group:a")
    assert switched_seed.selected_version.canonical_key == "hash:a-v1"
    assert switched.edges[0].target == "group:c"
