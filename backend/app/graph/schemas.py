"""Graph Pydantic schemas."""

from typing import Literal

from pydantic import BaseModel, Field

from app.papers.schemas import PaperMetadataRead


class GraphNode(BaseModel):
    id: str
    label: str | None = None
    type: Literal["paper", "paper_group"] = "paper"
    paper_group_key: str
    version_count: int = 1
    selected_version: PaperMetadataRead
    versions: list[PaperMetadataRead] = []
    is_seed: bool = False


class GraphEdge(BaseModel):
    source: str
    target: str
    relation_type: str


class GraphResponse(BaseModel):
    active_paper_key: str
    active_paper_group_key: str
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class GraphQuery(BaseModel):
    depth: int = Field(1, ge=1, le=5)
    max_nodes: int = Field(50, ge=1, le=200)
