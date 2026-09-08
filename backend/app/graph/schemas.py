"""Graph Pydantic schemas."""

from typing import Annotated, Literal

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


# ── Expansion ───────────────────────────────────────────────

CitingOrder = Literal["cited_by_count", "recent"]

# Which way to grow the graph from the chosen node(s):
#   cited_by → add papers that CITE them (citers; edge citer → node)
#   cites    → add papers they CITE (references; edge node → reference)
RelationDirection = Literal["cited_by", "cites"]


class ExpandRequest(BaseModel):
    """Grow the graph by one citation level.

    Adds related papers as new nodes. ``direction`` chooses citers vs.
    references. ``focus_key`` set → expand only that node (focused); ``None`` →
    expand every node in ``from_keys`` (global). ``existing_group_keys`` are the
    groups already on screen, so only genuinely new nodes are returned.
    """

    from_keys: list[Annotated[str, Field(min_length=1, max_length=512)]] = Field(
        default_factory=list, max_length=20
    )
    focus_key: str | None = Field(None, min_length=1, max_length=512)
    existing_group_keys: list[Annotated[str, Field(min_length=1, max_length=512)]] = Field(
        default_factory=list, max_length=200
    )
    direction: RelationDirection = "cited_by"
    order: CitingOrder = "cited_by_count"
    limit_per_node: int = Field(25, ge=1, le=50)


class ExpandResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
