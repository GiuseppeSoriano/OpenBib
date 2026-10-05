"""Graph service — grouped BFS traversal on paper_graph_edges."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections import deque
from collections.abc import Awaitable
from dataclasses import asdict

import redis.asyncio as aioredis
from redis.exceptions import RedisError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.identifiers import DOI_RE
from app.graph.models import PaperGraphEdge
from app.graph.schemas import GraphEdge, GraphNode, GraphResponse
from app.papers import service as paper_service
from app.papers.schemas import PaperMetadataRead
from app.providers import cache as provider_cache
from app.providers import registry
from app.providers.base import PaperMetadata
from app.providers.semantic_scholar import ProviderError

logger = logging.getLogger(__name__)


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
        paper = (
            paper_service.cached_paper_to_read(row)
            if row is not None
            else _fallback_paper(canonical_key)
        )
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


async def store_edges(db: AsyncSession, edges: list[dict]) -> None:
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
# Live citation pipeline: base graphs (related-paper ranges and top-ups live
# in `app.graph.related`).
#
# Edges are `cited_by`, directed citing → cited (arrow at the cited paper, so
# in-degree = citations received). Base graphs persist edges *among saved
# papers* in `paper_graph_edges`; related ranges fetch citing papers on the fly
# (Redis-cached) and only persist edges between papers already saved.
# ─────────────────────────────────────────────────────────────

CITED_BY = "cited_by"
_STRONG_PREFIXES = ("doi:", "s2:", "arxiv:", "pmid:", "pmcid:")
# Provider work for one base graph's edges (seed lookups, references) ends
# after this long; the response then flags its edges as partial.
_EDGE_BUDGET_SECONDS = 20.0
_STOP_CODES = frozenset(
    {"provider_rate_limited", "provider_not_configured", "provider_key_rejected"}
)


def _read_from_metadata(paper) -> PaperMetadataRead:
    """Provider PaperMetadata dataclass → API read schema (extra keys ignored)."""
    return PaperMetadataRead.model_validate(asdict(paper))


async def _resolve_read(db: AsyncSession, canonical_key: str) -> PaperMetadataRead:
    row = await paper_service.get_cached_paper(db, canonical_key)
    if row is not None:
        return paper_service.cached_paper_to_read(row)
    return _fallback_paper(canonical_key)


async def _within[T](call: Awaitable[T], deadline: float) -> T:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        if asyncio.iscoroutine(call):
            call.close()
        raise TimeoutError
    return await asyncio.wait_for(call, timeout=remaining)


def _stops(exc: BaseException) -> bool:
    """Whether ``exc`` ends provider work for this graph: out of time, rate
    limited (the adapter already backed off) or without a usable API key."""
    return isinstance(exc, TimeoutError) or (
        isinstance(exc, ProviderError) and exc.code in _STOP_CODES
    )


async def _lookup_seeds(
    identifiers: list[str], deadline: float
) -> tuple[list[PaperMetadata | None], Exception | None]:
    """Records for ``identifiers`` in order (``None`` for a miss) and the
    failure that left some unresolved, if any. Semantic Scholar rejects a
    whole batch for one identifier it cannot read, so such a batch is split
    in halves until that identifier is left out on its own."""
    try:
        return await _within(registry.papers_by_ids(identifiers), deadline), None
    except ProviderError as exc:
        if exc.code != "invalid_query":
            return [None] * len(identifiers), exc
        if len(identifiers) == 1:
            return [None], None
    except Exception as exc:
        return [None] * len(identifiers), exc
    mid = len(identifiers) // 2
    head, failure = await _lookup_seeds(identifiers[:mid], deadline)
    if failure is not None:
        return head + [None] * (len(identifiers) - mid), failure
    tail, failure = await _lookup_seeds(identifiers[mid:], deadline)
    return head + tail, failure


async def _resolve_graph_ids(
    db: AsyncSession, papers: list[PaperMetadataRead], deadline: float
) -> Exception | None:
    """Give seeds without a Semantic Scholar paperId one, from batch lookups
    by their DOI or other strong identifier (upserted; the stored record
    keeps its key and group). Returns the failure that left some seeds
    without one, if any."""
    pending = [
        (paper, identifier)
        for paper in papers
        if not paper.semantic_scholar_id and (identifier := registry.paper_identifier(paper))
    ]
    if not pending:
        return None
    found, failure = await _lookup_seeds([identifier for _, identifier in pending], deadline)
    if failure is not None:
        logger.warning("Seed lookup failed; graph edges may be missing", exc_info=failure)
    hits = [
        (paper, meta)
        for (paper, _), meta in zip(pending, found, strict=True)
        if meta is not None and meta.semantic_scholar_id
    ]
    if hits:
        await paper_service.cache_papers(db, [meta for _, meta in hits])
        for paper, meta in hits:
            paper.semantic_scholar_id = meta.semantic_scholar_id
    return failure


async def _references_one_by_one(
    graph_ids: list[str], deadline: float
) -> tuple[dict[str, list[str]], bool]:
    """Reference paperIds paper by paper, until ``deadline`` or a failure no
    later call would avoid; returns them with whether some are missing."""
    fetched: dict[str, list[str]] = {}
    partial = False
    for graph_id in graph_ids:
        try:
            fetched[graph_id] = await _within(registry.get_reference_ids(graph_id), deadline)
        except Exception as exc:
            partial = True
            if _stops(exc):
                break
            logger.warning("Reference lookup failed for a seed", exc_info=True)
    return fetched, partial


async def _reference_ids(
    redis: aioredis.Redis | None, graph_ids: list[str], deadline: float, *, fetch: bool = True
) -> tuple[dict[str, set[str]], bool]:
    """Reference paperIds of each paper (the papers it cites): the Redis
    cache, then (with ``fetch``) one batch call, else paper by paper until
    ``deadline``. Returns them with whether some could not be fetched."""
    refs: dict[str, set[str]] = {}
    missing: list[str] = []
    for graph_id in dict.fromkeys(graph_ids):
        cached = None
        if redis is not None:
            with contextlib.suppress(RedisError):
                cached = await provider_cache.cache_get(
                    redis, registry.CACHE_NAMESPACE, "references", "ids:" + graph_id
                )
        if cached is not None:
            refs[graph_id] = set(cached)
        else:
            missing.append(graph_id)
    if not missing:
        return refs, False
    if not fetch:
        return refs, True

    partial = False
    fetched: dict[str, list[str]] = {}
    try:
        fetched = await _within(registry.references_batch(missing), deadline)
    except Exception as exc:
        logger.warning("Batch reference lookup failed", exc_info=True)
        if _stops(exc):
            # No single call would get through either.
            partial = True
        else:
            fetched, partial = await _references_one_by_one(missing, deadline)
    # A paper the provider does not know has no references to link.
    for graph_id, ids in fetched.items():
        refs[graph_id] = set(ids)
        if redis is not None:
            with contextlib.suppress(RedisError):
                await provider_cache.cache_set(
                    redis,
                    registry.CACHE_NAMESPACE,
                    "references",
                    "ids:" + graph_id,
                    sorted(refs[graph_id]),
                )
    return refs, partial


async def saved_canonical_keys(db: AsyncSession, user_id: uuid.UUID) -> set[str]:
    """Canonical keys the user has saved (library version pins + collection
    papers). Used to decide which discovered edges are durable enough to store."""
    from app.collections.access import accessible_to
    from app.collections.models import Collection, CollectionPaper
    from app.library.models import UserLibraryVersion

    keys: set[str] = set()
    lib = await db.execute(
        select(UserLibraryVersion.paper_canonical_key).where(UserLibraryVersion.user_id == user_id)
    )
    keys.update(row[0] for row in lib.all())
    coll = await db.execute(
        select(CollectionPaper.paper_canonical_key)
        .join(Collection, Collection.id == CollectionPaper.collection_id)
        .where(accessible_to(user_id))
    )
    keys.update(row[0] for row in coll.all())
    return keys


async def library_seed_keys(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
    """Primary canonical keys of the user's library entries — graph seeds."""
    from app.library.models import UserLibraryEntry

    q = await db.execute(
        select(UserLibraryEntry.primary_canonical_key).where(UserLibraryEntry.user_id == user_id)
    )
    return [row[0] for row in q.all()]


async def _resolve_single_seed(db: AsyncSession, canonical_key: str) -> str:
    """Resolve an uncached seed with a strong key (DOI, Semantic Scholar,
    arXiv, PubMed, PubMed Central) once, so a graph opened from such a link
    shows the paper instead of a node titled with the raw key."""
    if not canonical_key.startswith(_STRONG_PREFIXES):
        return canonical_key
    row = await paper_service.get_cached_paper(db, canonical_key)
    if row is not None:
        return row.canonical_key
    prefix, _, value = canonical_key.partition(":")
    if prefix == "doi":
        if not DOI_RE.fullmatch(value):
            return canonical_key
        # A graph needs the record only: no doi.org check for a miss.
        lookup = await registry.resolve_doi(value, confirm_missing=False)
    else:
        lookup = await registry.resolve_id(canonical_key)
    if lookup.paper is None:
        return canonical_key
    # The upsert may keep an older key for the same work (alias merge).
    return (await paper_service.cache_papers(db, [lookup.paper]))[0].canonical_key


async def build_base_graph(
    db: AsyncSession,
    redis: aioredis.Redis | None,
    seed_keys: list[str],
    *,
    order: str = "cited_by_count",
) -> GraphResponse:
    """Graph of a set of saved papers + the citation edges *among them*.

    Edges come from each seed's references at Semantic Scholar intersected
    with the seed set (complete and bounded): seeds without a paperId are
    looked up in one batch, references come from the Redis cache, then one
    batch call, else seed by seed within the edge budget (``edges_partial``
    when it runs out or a lookup fails). Intra-set edges are persisted so the
    next open is fast.
    """
    seed_keys = list(dict.fromkeys(seed_keys))
    if len(seed_keys) == 1:
        seed_keys = [await _resolve_single_seed(db, seed_keys[0])]
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
    # Edges only link two seed groups: a one-group graph needs no provider call.
    edge_seeds = seed_papers if len(nodes) > 1 else []

    # Seed lookups and references share one budget; what it cannot cover is
    # reported as partial edges instead of failing the graph.
    deadline = time.monotonic() + _EDGE_BUDGET_SECONDS
    failure = await _resolve_graph_ids(db, edge_seeds, deadline) if edge_seeds else None
    partial = failure is not None
    graph_to_group = {
        paper.semantic_scholar_id: paper.paper_group_key
        for paper in edge_seeds
        if paper.semantic_scholar_id
    }
    refs: dict[str, set[str]] = {}
    if graph_to_group:
        # After a rate limit or a key problem only cached references are read.
        fetch = failure is None or not _stops(failure)
        refs, refs_partial = await _reference_ids(
            redis, list(graph_to_group), deadline, fetch=fetch
        )
        partial = partial or refs_partial

    edges: set[tuple[str, str, str]] = set()
    edges_to_store: dict[tuple[str, str], dict] = {}
    for paper in edge_seeds:
        for ref_id in sorted(refs.get(paper.semantic_scholar_id or "", ())):
            cited_group = graph_to_group.get(ref_id)
            if cited_group is None or cited_group == paper.paper_group_key:
                continue
            edges.add((paper.paper_group_key, cited_group, CITED_BY))
            cited_node = nodes.get(cited_group)
            if cited_node is not None:
                target = cited_node.selected_version.canonical_key
                edges_to_store[(paper.canonical_key, target)] = {
                    "source_key": paper.canonical_key,
                    "target_key": target,
                    "relation_type": CITED_BY,
                    "provider_source": registry.PRIMARY_PROVIDER,
                }
    if edges_to_store:
        await store_edges(db, list(edges_to_store.values()))

    first = seed_papers[0] if seed_papers else None
    return GraphResponse(
        active_paper_key=first.canonical_key if first else "",
        active_paper_group_key=first.paper_group_key if first else "",
        nodes=list(nodes.values()),
        edges=[GraphEdge(source=s, target=t, relation_type=r) for s, t, r in sorted(edges)],
        edges_partial=partial,
    )
