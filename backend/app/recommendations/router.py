"""Recommendations – router."""

from fastapi import APIRouter, Query

from app.dependencies import DB, CurrentUser
from app.recommendations.schemas import RecommendationItem, RecommendationResponse
from app.recommendations.service import get_similar

router = APIRouter(prefix="/recommendations", tags=["recommendations"])


@router.get("/{paper_key:path}", response_model=RecommendationResponse)
async def recommend(
    paper_key: str,
    db: DB,
    user: CurrentUser,
    limit: int = Query(10, ge=1, le=50),
):
    items = await get_similar(db, paper_key, limit=limit)
    return RecommendationResponse(
        paper_key=paper_key,
        recommendations=[RecommendationItem(**i) for i in items],
    )
