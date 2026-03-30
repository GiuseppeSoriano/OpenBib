"""Graph Pydantic schemas."""

from pydantic import BaseModel, Field


class GraphNode(BaseModel):
    id: str
    label: str | None = None
    type: str = "paper"


class GraphEdge(BaseModel):
    source: str
    target: str
    relation_type: str


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class GraphQuery(BaseModel):
    depth: int = Field(1, ge=1, le=5)
    max_nodes: int = Field(50, ge=1, le=200)
