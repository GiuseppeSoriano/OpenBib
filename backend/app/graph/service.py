"""Graph service — grouped BFS traversal on paper_graph_edges."""

from __future__ import annotations

import uuid
from collections import deque
from dataclasses import asdict

import redis.asyncio as aioredis
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.models import PaperGraphEdge
from app.graph.schemas import ExpandResponse, GraphEdge, GraphNode, GraphResponse
from app.papers import service as paper_service
from app.papers.schemas import PaperMetadataRead
from app.providers import cache as provider_cache
from app.providers import registry


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


# ─────────────────────────────────────────────────────────────
# Live citation pipeline: base graphs + one-level expansion.
#
# Edges are `cited_by`, directed citing → cited (arrow at the cited paper, so
# in-degree = citations received). Base graphs persist edges *among saved
# papers* in `paper_graph_edges`; expansion fetches citing papers on the fly
# (Redis-cached) and only persists edges between papers already saved.
# ─────────────────────────────────────────────────────────────

CITED_BY = "cited_by"


def _read_from_metadata(paper) -> PaperMetadataRead:
    """Provider PaperMetadata dataclass → API read schema (extra keys ignored)."""
    return PaperMetadataRead.model_validate(asdict(paper))


def _node_from_read(paper: PaperMetadataRead, *, is_seed: bool = False) -> GraphNode:
    """Single-version node built directly from freshly-fetched metadata."""
    return GraphNode(
        id=paper.paper_group_key,
        label=paper.title,
        type="paper",
        paper_group_key=paper.paper_group_key,
        version_count=1,
        selected_version=paper,
        versions=[paper],
        is_seed=is_seed,
    )


async def _resolve_read(db: AsyncSession, canonical_key: str) -> PaperMetadataRead:
    row = await paper_service.get_cached_paper(db, canonical_key)
    if row is not None:
        return paper_service.cached_paper_to_read(row)
    return _fallback_paper(canonical_key)


async def _resolve_openalex_id(db: AsyncSession, paper: PaperMetadataRead) -> str | None:
    """OpenAlex work id for a paper, looking it up by DOI (and caching) if the
    cached metadata doesn't already carry one. Returns None for papers we can't
    map (e.g. hash-only keys with no DOI) — callers degrade gracefully."""
    if paper.openalex_id:
        return paper.openalex_id
    if paper.doi:
        meta = await registry.lookup_by_doi(paper.doi)
        if meta is not None:
            await paper_service.cache_papers(db, [meta])
            return meta.openalex_id
    return None


async def fetch_citing(
    db: AsyncSession,
    redis: aioredis.Redis | None,
    paper: PaperMetadataRead,
    *,
    order: str = "cited_by_count",
    limit: int = 25,
) -> list[PaperMetadataRead]:
    """Papers that cite ``paper``, fully mapped. Redis-cached per
    (work, order, limit); fetched papers are upserted into the metadata cache
    so they resolve consistently elsewhere."""
    openalex_id = await _resolve_openalex_id(db, paper)
    if not openalex_id:
        return []
    cache_id = f"{openalex_id}|{order}|{limit}"
    if redis is not None:
        cached = await provider_cache.cache_get(redis, "openalex", "citations", cache_id)
        if cached is not None:
            return [PaperMetadataRead.model_validate(item) for item in cached]
    papers = await registry.list_citing_papers(openalex_id, order=order, limit=limit)
    if papers:
        await paper_service.cache_papers(db, papers)
    reads = [_read_from_metadata(p) for p in papers]
    if redis is not None:
        await provider_cache.cache_set(
            redis,
            "openalex",
            "citations",
            cache_id,
            [r.model_dump(mode="json") for r in reads],
        )
    return reads


async def _fetch_referenced_ids(
    db: AsyncSession, redis: aioredis.Redis | None, paper: PaperMetadataRead
) -> set[str]:
    """OpenAlex ids referenced by ``paper`` (i.e. papers it cites), Redis-cached."""
    openalex_id = await _resolve_openalex_id(db, paper)
    if not openalex_id:
        return set()
    if redis is not None:
        cached = await provider_cache.cache_get(redis, "openalex", "references", openalex_id)
        if cached is not None:
            return set(cached)
    ids = await registry.get_openalex_reference_ids(openalex_id)
    if redis is not None:
        await provider_cache.cache_set(
            redis, "openalex", "references", openalex_id, sorted(set(ids))
        )
    return set(ids)


async def saved_canonical_keys(db: AsyncSession, user_id: uuid.UUID) -> set[str]:
    """Canonical keys the user has saved (library version pins + collection
    papers). Used to decide which discovered edges are durable enough to store."""
    from app.collections.models import Collection, CollectionPaper
    from app.library.models import UserLibraryVersion

    keys: set[str] = set()
    lib = await db.execute(
        select(UserLibraryVersion.paper_canonical_key).where(
            UserLibraryVersion.user_id == user_id
        )
    )
    keys.update(row[0] for row in lib.all())
    coll = await db.execute(
        select(CollectionPaper.paper_canonical_key)
        .join(Collection, Collection.id == CollectionPaper.collection_id)
        .where(Collection.owner_id == user_id)
    )
    keys.update(row[0] for row in coll.all())
    return keys


async def library_seed_keys(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
    """Primary canonical keys of the user's library entries — graph seeds."""
    from app.library.models import UserLibraryEntry

    q = await db.execute(
        select(UserLibraryEntry.primary_canonical_key).where(
            UserLibraryEntry.user_id == user_id
        )
    )
    return [row[0] for row in q.all()]


async def build_base_graph(
    db: AsyncSession,
    redis: aioredis.Redis | None,
    seed_keys: list[str],
    *,
    order: str = "cited_by_count",
) -> GraphResponse:
    """Graph of a set of saved papers + the citation edges *among them*.

    Edges come from each seed's OpenAlex ``referenced_works`` intersected with
    the seed set (complete and bounded). Intra-set edges are persisted so the
    next open is fast.
    """
    seed_keys = list(dict.fromkeys(seed_keys))
    canonical_cache: dict[str, PaperMetadataRead] = {}
    group_cache: dict[str, list[PaperMetadataRead]] = {}
    nodes: dict[str, GraphNode] = {}

    async def resolve_paper(canonical_key: str) -> PaperMetadataRead:
        if canonical_key not in canonical_cache:
            canonical_cache[canonical_key] = await _resolve_read(db, canonical_key)
        return canonical_cache[canonical_key]

    async def ensure_node(canonical_key: str) -> PaperMetadataRead:
        paper = await resolve_paper(canonical_key)
        group_key = paper.paper_group_key
        if group_key not in group_cache:
            rows = await paper_service.get_cached_papers_by_group(db, group_key)
            versions = [paper_service.cached_paper_to_read(r) for r in rows] or [paper]
            group_cache[group_key] = versions
            for v in versions:
                canonical_cache.setdefault(v.canonical_key, v)
        versions = group_cache[group_key]
        selected = _select_version(versions, fallback_key=canonical_key)
        if group_key not in nodes:
            nodes[group_key] = GraphNode(
                id=group_key,
                label=selected.title,
                type="paper_group" if len(versions) > 1 else "paper",
                paper_group_key=group_key,
                version_count=len(versions),
                selected_version=selected,
                versions=versions,
                is_seed=True,
            )
        return paper

    seed_papers = [await ensure_node(key) for key in seed_keys]

    openalex_to_group: dict[str, str] = {
        p.openalex_id: p.paper_group_key for p in seed_papers if p.openalex_id
    }

    edges: set[tuple[str, str, str]] = set()
    edges_to_store: list[dict] = []
    for paper in seed_papers:
        if not paper.openalex_id:
            continue
        ref_ids = await _fetch_referenced_ids(db, redis, paper)
        for ref_id in ref_ids:
            cited_group = openalex_to_group.get(ref_id)
            if cited_group is None or cited_group == paper.paper_group_key:
                continue
            edges.add((paper.paper_group_key, cited_group, CITED_BY))
            cited_node = nodes.get(cited_group)
            if cited_node is not None:
                edges_to_store.append(
                    {
                        "source_key": paper.canonical_key,
                        "target_key": cited_node.selected_version.canonical_key,
                        "relation_type": CITED_BY,
                        "provider_source": "openalex",
                    }
                )
    if edges_to_store:
        await store_edges(db, edges_to_store)

    first = seed_papers[0] if seed_papers else None
    return GraphResponse(
        active_paper_key=first.canonical_key if first else "",
        active_paper_group_key=first.paper_group_key if first else "",
        nodes=list(nodes.values()),
        edges=[GraphEdge(source=s, target=t, relation_type=r) for s, t, r in sorted(edges)],
    )


async def expand_graph(
    db: AsyncSession,
    redis: aioredis.Redis | None,
    *,
    from_keys: list[str],
    focus_key: str | None = None,
    existing_group_keys: list[str] | None = None,
    order: str = "cited_by_count",
    limit_per_node: int = 25,
    saved_keys: set[str] | None = None,
) -> ExpandResponse:
    """Grow the graph by one citation level — add papers that *cite* the chosen
    nodes as new leaves. Returns only new leaf nodes plus the citing→cited edges
    (including edges onto nodes already on screen). Persists an edge only when
    both endpoints are saved papers."""
    existing = set(existing_group_keys or [])
    saved = saved_keys or set()
    targets = [focus_key] if focus_key else list(dict.fromkeys(from_keys))

    new_nodes: dict[str, GraphNode] = {}
    edges: set[tuple[str, str, str]] = set()
    edges_to_store: list[dict] = []

    for from_key in targets:
        if not from_key:
            continue
        from_paper = await _resolve_read(db, from_key)
        from_group = from_paper.paper_group_key
        citing = await fetch_citing(db, redis, from_paper, order=order, limit=limit_per_node)
        for citer in citing:
            cgroup = citer.paper_group_key
            if cgroup == from_group:
                continue
            edges.add((cgroup, from_group, CITED_BY))
            if cgroup not in existing and cgroup not in new_nodes:
                new_nodes[cgroup] = _node_from_read(citer)
            if citer.canonical_key in saved and from_key in saved:
                edges_to_store.append(
                    {
                        "source_key": citer.canonical_key,
                        "target_key": from_key,
                        "relation_type": CITED_BY,
                        "provider_source": "openalex",
                    }
                )
    if edges_to_store:
        await store_edges(db, edges_to_store)

    return ExpandResponse(
        nodes=list(new_nodes.values()),
        edges=[GraphEdge(source=s, target=t, relation_type=r) for s, t, r in sorted(edges)],
    )
