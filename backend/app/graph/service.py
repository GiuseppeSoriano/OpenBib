"""Graph service — BFS traversal on paper_graph_edges."""

from collections import deque

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.models import PaperGraphEdge
from app.graph.schemas import GraphEdge, GraphNode, GraphResponse


async def get_neighborhood(
    db: AsyncSession, paper_key: str, depth: int = 1, max_nodes: int = 50
) -> GraphResponse:
    visited: set[str] = set()
    queue: deque[tuple[str, int]] = deque([(paper_key, 0)])
    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []

    while queue and len(visited) < max_nodes:
        current_key, current_depth = queue.popleft()
        if current_key in visited:
            continue
        visited.add(current_key)
        nodes.append(GraphNode(id=current_key, label=current_key))

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
        for edge in result.scalars().all():
            edges.append(
                GraphEdge(
                    source=edge.source_key,
                    target=edge.target_key,
                    relation_type=edge.relation_type,
                )
            )
            neighbor = edge.target_key if edge.source_key == current_key else edge.source_key
            if neighbor not in visited:
                queue.append((neighbor, current_depth + 1))

    return GraphResponse(nodes=nodes, edges=edges)


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
