"""Recommendations service — co-citation based similarity."""

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.models import PaperGraphEdge


async def get_similar(db: AsyncSession, paper_key: str, limit: int = 10) -> list[dict]:
    """Find papers that share the most citations/references with the given paper."""
    # Get all papers connected to the seed paper
    refs = await db.execute(
        select(PaperGraphEdge.target_key).where(
            PaperGraphEdge.source_key == paper_key,
            PaperGraphEdge.relation_type.in_(["cites", "cited_by"]),
        )
    )
    related_keys = {row[0] for row in refs.all()}

    if not related_keys:
        return []

    # Find papers that also connect to those same papers (co-citation)
    co_cited = await db.execute(
        select(
            PaperGraphEdge.source_key,
            func.count().label("overlap"),
        )
        .where(
            PaperGraphEdge.target_key.in_(related_keys),
            PaperGraphEdge.source_key != paper_key,
            PaperGraphEdge.relation_type.in_(["cites", "cited_by"]),
        )
        .group_by(PaperGraphEdge.source_key)
        .order_by(func.count().desc())
        .limit(limit)
    )

    results = []
    for row in co_cited.all():
        results.append(
            {
                "canonical_key": row.source_key,
                "title": row.source_key,  # Would be enriched from cache in production
                "score": row.overlap,
                "reason": f"Shares {row.overlap} citation(s) with the seed paper",
            }
        )
    return results
