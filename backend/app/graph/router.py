"""Graph router — citation graphs for a paper, a collection, or the library,
plus one-level citation expansion."""

import uuid
from typing import Literal

from fastapi import APIRouter, Query

from app.collections import service as collection_service
from app.dependencies import DB, CurrentUser, Redis
from app.graph import service
from app.graph.schemas import ExpandRequest, ExpandResponse, GraphResponse

router = APIRouter(prefix="/graph", tags=["graph"])

Order = Literal["cited_by_count", "recent"]


@router.post("/expand", response_model=ExpandResponse)
async def expand_graph(body: ExpandRequest, user: CurrentUser, db: DB, redis: Redis):
    """Add papers that cite the chosen node(s) as new leaves (focused if
    ``focus_key`` is set, otherwise global over ``from_keys``)."""
    saved = await service.saved_canonical_keys(db, user.id)
    return await service.expand_graph(
        db,
        redis,
        from_keys=body.from_keys,
        focus_key=body.focus_key,
        existing_group_keys=body.existing_group_keys,
        order=body.order,
        limit_per_node=body.limit_per_node,
        saved_keys=saved,
    )


@router.get("/library", response_model=GraphResponse)
async def library_graph(
    user: CurrentUser,
    db: DB,
    redis: Redis,
    order: Order = Query("cited_by_count"),
):
    """Citation graph of every paper in the user's library."""
    seeds = await service.library_seed_keys(db, user.id)
    return await service.build_base_graph(db, redis, seeds, order=order)


@router.get("/collection/{collection_id}", response_model=GraphResponse)
async def collection_graph(
    collection_id: uuid.UUID,
    user: CurrentUser,
    db: DB,
    redis: Redis,
    order: Order = Query("cited_by_count"),
):
    """Citation graph of every paper in a collection (view RBAC enforced)."""
    rows = await collection_service.list_papers(db, collection_id, user.id)
    seeds = [row["paper_canonical_key"] for row in rows]
    return await service.build_base_graph(db, redis, seeds, order=order)


@router.get("/paper/{paper_key:path}", response_model=GraphResponse)
async def paper_graph(
    paper_key: str,
    user: CurrentUser,
    db: DB,
    redis: Redis,
    order: Order = Query("cited_by_count"),
):
    """Single-seed base graph. The frontend immediately expands it once so the
    first level of citing papers is shown."""
    return await service.build_base_graph(db, redis, [paper_key], order=order)


@router.get("/{paper_key:path}", response_model=GraphResponse)
async def get_graph(
    paper_key: str,
    user: CurrentUser,
    db: DB,
    redis: Redis,
    order: Order = Query("cited_by_count"),
):
    """Legacy alias for single-paper graphs (kept for back-compat)."""
    return await service.build_base_graph(db, redis, [paper_key], order=order)
