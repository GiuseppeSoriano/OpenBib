"""Recommendations – schemas."""

from pydantic import BaseModel


class RecommendationItem(BaseModel):
    canonical_key: str
    title: str | None = None
    score: float
    reason: str | None = None


class RecommendationResponse(BaseModel):
    paper_key: str
    recommendations: list[RecommendationItem]
