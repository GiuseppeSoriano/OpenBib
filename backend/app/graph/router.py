"""Graph router — citation graphs for a paper, a collection, or the library,
plus related-paper ranges and pinned top-ups.

Single-paper graphs, shared-collection graphs, related ranges and top-ups
are usable without an account (anonymous exploration); only the library graph
is inherently user-scoped and requires auth.
"""

import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from app.collections import service as collection_service
from app.collections.access import ShareToken
from app.common.exceptions import ApiError
from app.common.identifiers import PaperKey
from app.common.rate_limit import client_ip, enforce_rate_limit
from app.config import settings
from app.dependencies import DB, CurrentUser, OptionalUser, Redis
from app.graph import related, service
from app.graph.schemas import (
    GraphResponse,
    RelatedRangeRequest,
    RelatedRangeResponse,
    TopUpRequest,
    TopUpResponse,
)

router = APIRouter(prefix="/graph", tags=["graph"])

Order = Literal["cited_by_count", "recent"]
# Base graphs are the seeds plus the edges among them; ordering only applies
# to related-paper ranges. The parameter stays accepted for old clients.
_ORDER_DOC = "Deprecated and ignored: ordering applies to POST /graph/related."


def _provider_unavailable(exc: related.RelatedProviderError) -> ApiError:
    """503 ``related_provider_unavailable``; ``reason`` tells an outage, a
    timeout, a rate limit (with ``Retry-After``) and a missing API key apart."""
    extra: dict = {"reason": exc.kind}
    headers = None
    # Clients read a Retry-After on a 503 as a rate limit: an outage's
    # suggested wait is not sent.
    if exc.kind == "rate_limited" and exc.retry_after is not None:
        extra["retry_after"] = exc.retry_after
        headers = {"Retry-After": str(exc.retry_after)}
    return ApiError(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "related_provider_unavailable",
        "Citation data from Semantic Scholar is unavailable. Try again in a moment.",
        headers=headers,
        **extra,
    )


@router.post("/related", response_model=RelatedRangeResponse)
async def related_range(
    body: RelatedRangeRequest,
    request: Request,
    response: Response,
    user: OptionalUser,
    db: DB,
    redis: Redis,
):
    """One range of a node's citers or references: positions in the ranked
    list of unique papers minus the source and the caller's pinned groups.
    While Semantic Scholar's list is still being collected the response has
    ``reason="ranking"`` and no nodes. Public; only signed-in callers get
    citation edges between saved papers stored."""
    await enforce_rate_limit(
        redis,
        request,
        response,
        scope="graph-related",
        identity=f"user:{user.id}" if user else client_ip(request),
        limit=60 if user else 20,
        window_seconds=60,
        fail_closed=True,
    )
    size = settings.graph_related_range_size
    if body.range_start % size:
        raise ApiError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "range_start_not_aligned",
            f"range_start must be a multiple of {size}",
            range_size=size,
        )
    saved = await service.saved_canonical_keys(db, user.id) if user else set()
    source = await related.load_source(db, body.source_key, body.source_group_key)
    # Release the per-user row lock (taken on every authenticated POST)
    # before any Redis or provider work.
    await db.commit()
    try:
        return await related.related_range(db, redis, body, source, saved)
    except related.RelatedProviderError as exc:
        raise _provider_unavailable(exc) from exc


@router.post("/related/top-up", response_model=TopUpResponse)
async def related_top_up(
    body: TopUpRequest,
    request: Request,
    response: Response,
    user: OptionalUser,
    db: DB,
    redis: Redis,
):
    """Expand pinned nodes: bring each source's branch up to
    ``target_per_source`` connected papers. Per-source failures come back in
    that source's ``error``; the request fails only when every source does."""
    await enforce_rate_limit(
        redis,
        request,
        response,
        scope="graph-expand",
        identity=f"user:{user.id}" if user else client_ip(request),
        limit=30 if user else 10,
        window_seconds=60,
        fail_closed=True,
    )
    size = settings.graph_related_range_size
    if body.target_per_source > size:
        raise ApiError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "target_per_source_too_large",
            f"target_per_source must be at most {size}",
            range_size=size,
        )
    saved = await service.saved_canonical_keys(db, user.id) if user else set()
    sources = [
        await related.load_source(db, spec.source_key, spec.source_group_key)
        for spec in body.sources
    ]
    await db.commit()
    try:
        return await related.related_top_up(db, redis, body, sources, saved)
    except related.RelatedProviderError as exc:
        raise _provider_unavailable(exc) from exc


@router.get("/library", response_model=GraphResponse)
async def library_graph(
    user: CurrentUser,
    db: DB,
    redis: Redis,
    request: Request,
    response: Response,
    order: Order = Query("cited_by_count", deprecated=True, description=_ORDER_DOC),
):
    """Citation graph of every paper in the user's library."""
    await enforce_rate_limit(
        redis,
        request,
        response,
        scope="graph-build",
        identity=f"user:{user.id}",
        limit=30,
        window_seconds=60,
        fail_closed=True,
    )
    seeds = await service.library_seed_keys(db, user.id)
    if len(seeds) > 200:
        raise HTTPException(status_code=422, detail="Graph is limited to 200 seed papers")
    return await service.build_base_graph(db, redis, seeds, order=order)


@router.get("/collection/{collection_id}", response_model=GraphResponse)
async def collection_graph(
    collection_id: uuid.UUID,
    user: OptionalUser,
    db: DB,
    redis: Redis,
    request: Request,
    response: Response,
    order: Order = Query("cited_by_count", deprecated=True, description=_ORDER_DOC),
    share_token: ShareToken = None,
):
    """Citation graph of every paper in a collection. View RBAC is enforced
    by list_papers: anonymous users need a valid read link."""
    await enforce_rate_limit(
        redis,
        request,
        response,
        scope="graph-build",
        identity=f"user:{user.id}" if user else client_ip(request),
        limit=30 if user else 10,
        window_seconds=60,
        fail_closed=True,
    )
    rows = await collection_service.list_papers(
        db, collection_id, user.id if user else None, share_token
    )
    seeds = [row["paper_canonical_key"] for row in rows]
    if len(seeds) > 200:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Collection graph is limited to 200 seed papers",
        )
    return await service.build_base_graph(db, redis, seeds, order=order)


@router.get("/paper/{paper_key:path}", response_model=GraphResponse)
async def paper_graph(
    paper_key: PaperKey,
    db: DB,
    redis: Redis,
    request: Request,
    response: Response,
    order: Order = Query("cited_by_count", deprecated=True, description=_ORDER_DOC),
):
    """Single-seed base graph (public — anonymous exploration entry point)."""
    await enforce_rate_limit(
        redis,
        request,
        response,
        scope="graph-build",
        identity=client_ip(request),
        limit=10,
        window_seconds=60,
        fail_closed=True,
    )
    return await service.build_base_graph(db, redis, [paper_key], order=order)


@router.get("/{paper_key:path}", response_model=GraphResponse)
async def get_graph(
    paper_key: PaperKey,
    db: DB,
    redis: Redis,
    request: Request,
    response: Response,
    order: Order = Query("cited_by_count", deprecated=True, description=_ORDER_DOC),
):
    """Legacy alias for single-paper graphs (kept for back-compat)."""
    await enforce_rate_limit(
        redis,
        request,
        response,
        scope="graph-build",
        identity=client_ip(request),
        limit=10,
        window_seconds=60,
        fail_closed=True,
    )
    return await service.build_base_graph(db, redis, [paper_key], order=order)
