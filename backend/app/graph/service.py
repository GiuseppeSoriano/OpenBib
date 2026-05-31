"""Graph service — grouped BFS traversal on paper_graph_edges."""

from __future__ import annotations

from collections import deque

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.models import PaperGraphEdge
from app.graph.schemas import GraphEdge, GraphNode, GraphResponse
from app.papers import service as paper_service
from app.papers.schemas import PaperMetadataRead


def _fallback_paper(canonical_key: str) -> PaperMetadataRead:
    return PaperMetadataRead.model_validate(
        {
            "canonical_key": canonical_key,
            "paper_group_key": canonical_key,
            "title": canonical_key,
            "authors": [],
            "provider_source": "unknown",
        }
    )


def _select_version(
    versions: list[PaperMetadataRead],
    override_key: str | None = None,
    fallback_key: str | None = None,
) -> PaperMetadataRead:
    by_key = {paper.canonical_key: paper for paper in versions}
    if override_key and override_key in by_key:
        return by_key[override_key]
    if fallback_key and fallback_key in by_key:
        return by_key[fallback_key]
    return versions[0]


async def get_neighborhood(
    db: AsyncSession,
    paper_key: str,
    depth: int = 1,
    max_nodes: int = 50,
    selected_versions: dict[str, str] | None = None,
) -> GraphResponse:
    selected_versions = selected_versions or {}
    canonical_cache: dict[str, PaperMetadataRead] = {}
    group_cache: dict[str, list[PaperMetadataRead]] = {}
    visible_groups: dict[str, GraphNode] = {}
    merged_edges: set[tuple[str, str, str]] = set()

    async def resolve_paper(canonical_key: str) -> PaperMetadataRead:
        if canonical_key in canonical_cache:
            return canonical_cache[canonical_key]
        row = await paper_service.get_cached_paper(db, canonical_key)
        paper = paper_service.cached_paper_to_read(row) if row is not None else _fallback_paper(canonical_key)
        canonical_cache[canonical_key] = paper
        return paper

    async def resolve_group_versions(
        paper_group_key: str, fallback_paper: PaperMetadataRead
    ) -> list[PaperMetadataRead]:
        if paper_group_key in group_cache:
            return group_cache[paper_group_key]
        rows = await paper_service.get_cached_papers_by_group(db, paper_group_key)
        versions = [paper_service.cached_paper_to_read(row) for row in rows]
        if not versions:
            versions = [fallback_paper]
        group_cache[paper_group_key] = versions
        for paper in versions:
            canonical_cache[paper.canonical_key] = paper
        return versions

    async def ensure_group_node(
        paper_group_key: str,
        fallback_paper: PaperMetadataRead,
        is_seed: bool = False,
    ) -> GraphNode:
        versions = await resolve_group_versions(paper_group_key, fallback_paper)
        selected_version = _select_version(
            versions,
            override_key=selected_versions.get(paper_group_key),
            fallback_key=fallback_paper.canonical_key if is_seed else None,
        )
        node = GraphNode(
            id=paper_group_key,
            label=selected_version.title,
            type="paper_group" if len(versions) > 1 else "paper",
            paper_group_key=paper_group_key,
            version_count=len(versions),
            selected_version=selected_version,
            versions=versions,
            is_seed=is_seed,
        )
        visible_groups[paper_group_key] = node
        return node

    seed_paper = await resolve_paper(paper_key)
    seed_group_key = seed_paper.paper_group_key
    seed_node = await ensure_group_node(seed_group_key, seed_paper, is_seed=True)

    visited_groups: set[str] = set()
    queued_groups: set[str] = {seed_group_key}
    queue: deque[tuple[str, int]] = deque([(seed_group_key, 0)])

    while queue and len(visited_groups) < max_nodes:
        current_group_key, current_depth = queue.popleft()
        if current_group_key in visited_groups:
            continue
        queued_groups.discard(current_group_key)
        visited_groups.add(current_group_key)

        current_node = visible_groups[current_group_key]
        current_key = current_node.selected_version.canonical_key

        if current_depth >= depth:
            continue

        result = await db.execute(
            select(PaperGraphEdge).where(
                or_(
                    PaperGraphEdge.source_key == current_key,
                    PaperGraphEdge.target_key == current_key,
                )
            )
        )
        raw_edges = list(result.scalars().all())
        if not raw_edges:
            continue

        batch_keys = {current_key}
        for edge in raw_edges:
            batch_keys.add(edge.source_key)
            batch_keys.add(edge.target_key)
        cached_batch = await paper_service.get_cached_papers_by_keys(db, batch_keys)
        for key, row in cached_batch.items():
            canonical_cache[key] = paper_service.cached_paper_to_read(row)

        for edge in raw_edges:
            source_paper = await resolve_paper(edge.source_key)
            target_paper = await resolve_paper(edge.target_key)

            source_node = await ensure_group_node(
                source_paper.paper_group_key,
                source_paper,
                is_seed=source_paper.paper_group_key == seed_group_key,
            )
            target_node = await ensure_group_node(
                target_paper.paper_group_key,
                target_paper,
                is_seed=target_paper.paper_group_key == seed_group_key,
            )

            if source_node.id == target_node.id:
                continue

            merged_edges.add((source_node.id, target_node.id, edge.relation_type))

            neighbor_group_key = (
                target_node.id if edge.source_key == current_key else source_node.id
            )
            if (
                neighbor_group_key not in visited_groups
                and neighbor_group_key not in queued_groups
                and len(visited_groups) + len(queued_groups) < max_nodes
            ):
                queue.append((neighbor_group_key, current_depth + 1))
                queued_groups.add(neighbor_group_key)

    nodes = [
        visible_groups[group_key]
        for group_key in visible_groups
        if group_key in visited_groups or group_key in queued_groups
    ]
    edges = [
        GraphEdge(source=source, target=target, relation_type=relation_type)
        for source, target, relation_type in sorted(merged_edges)
        if source in {node.id for node in nodes} and target in {node.id for node in nodes}
    ]

    return GraphResponse(
        active_paper_key=seed_node.selected_version.canonical_key,
        active_paper_group_key=seed_group_key,
        nodes=nodes,
        edges=edges,
    )


async def store_edges(
    db: AsyncSession, edges: list[dict]
) -> None:
    for edge_data in edges:
        existing = await db.execute(
            select(PaperGraphEdge).where(
                PaperGraphEdge.source_key == edge_data["source_key"],
                PaperGraphEdge.target_key == edge_data["target_key"],
                PaperGraphEdge.relation_type == edge_data["relation_type"],
            )
        )
        if existing.scalar_one_or_none() is None:
            db.add(PaperGraphEdge(**edge_data))
    await db.flush()
