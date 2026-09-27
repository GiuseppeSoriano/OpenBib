"""Graph router — citation graphs for a paper, a collection, or the library,
plus one-level citation expansion.

Single-paper graphs, public-collection graphs, and expansion are usable
without an account (anonymous exploration); only the library graph is
inherently user-scoped and requires auth.
"""

import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from app.collections import service as collection_service
from app.collections.access import ShareToken
from app.common.rate_limit import client_ip, enforce_rate_limit
from app.dependencies import DB, CurrentUser, OptionalUser, Redis
from app.graph import service
from app.graph.schemas import ExpandRequest, ExpandResponse, GraphResponse

router = APIRouter(prefix="/graph", tags=["graph"])

Order = Literal["cited_by_count", "recent"]


@router.post("/expand", response_model=ExpandResponse)
async def expand_graph(
    body: ExpandRequest,
    request: Request,
    response: Response,
    user: OptionalUser,
    db: DB,
    redis: Redis,
):
    """Add papers that cite the chosen node(s) as new leaves (focused if
    ``focus_key`` is set, otherwise global over ``from_keys``).

    Anonymous callers get the same expansion but with no saved-paper set,
    so no user-scoped edges are persisted."""
    identity = f"user:{user.id}" if user else client_ip(request)
    await enforce_rate_limit(
        redis,
        request,
        response,
        scope="graph-expand",
        identity=identity,
        limit=30 if user else 10,
        window_seconds=60,
        fail_closed=True,
    )
    saved = await service.saved_canonical_keys(db, user.id) if user else set()
    return await service.expand_graph(
        db,
        redis,
        from_keys=body.from_keys,
        focus_key=body.focus_key,
        existing_group_keys=body.existing_group_keys,
        direction=body.direction,
        order=body.order,
        limit_per_node=body.limit_per_node,
        saved_keys=saved,
    )


@router.get("/library", response_model=GraphResponse)
async def library_graph(
    user: CurrentUser,
    db: DB,
    redis: Redis,
    request: Request,
    response: Response,
    order: Order = Query("cited_by_count"),
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
    order: Order = Query("cited_by_count"),
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
    paper_key: str,
    db: DB,
    redis: Redis,
    request: Request,
    response: Response,
    order: Order = Query("cited_by_count"),
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
    paper_key: str,
    db: DB,
    redis: Redis,
    request: Request,
    response: Response,
    order: Order = Query("cited_by_count"),
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
