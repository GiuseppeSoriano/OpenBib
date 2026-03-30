"""Graph router."""

from fastapi import APIRouter, Query

from app.dependencies import DB, CurrentUser
from app.graph import service
from app.graph.schemas import GraphResponse

router = APIRouter(prefix="/graph", tags=["graph"])


@router.get("/{paper_key:path}", response_model=GraphResponse)
async def get_graph(
    paper_key: str,
    user: CurrentUser,
    db: DB,
    depth: int = Query(1, ge=1, le=5),
    max_nodes: int = Query(50, ge=1, le=200),
):
    return await service.get_neighborhood(db, paper_key, depth, max_nodes)
