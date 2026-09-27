"""Graph Pydantic schemas."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from app.common.identifiers import PaperKey
from app.config import settings
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
    # Lets the client size its range controls before the first related call.
    related_range_size: int = Field(default_factory=lambda: settings.graph_related_range_size)
    related_max_results: int = Field(default_factory=lambda: settings.graph_related_max_results)


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


# ── Related-paper ranges ────────────────────────────────────

GroupKey = Annotated[str, Field(min_length=1, max_length=512)]


class RelatedRangeRequest(BaseModel):
    """One range of a node's citers or references. Ranges are positions in the
    eligible list: first occurrence per paper group, minus the source and the
    caller's pinned groups (``exclude_group_keys``, pins only)."""

    source_key: PaperKey
    source_group_key: GroupKey
    direction: RelationDirection = "cited_by"
    order: CitingOrder = "cited_by_count"
    # A multiple of the range size (checked by the router); past the end it
    # is clamped to the last range.
    range_start: int = Field(0, ge=0, le=50_000)
    last: bool = False
    exclude_group_keys: list[GroupKey] = Field(default_factory=list, max_length=500)


class RelatedRangeResponse(BaseModel):
    source_key: str
    source_group_key: str
    direction: RelationDirection
    order: CitingOrder
    # The served range in rank order, including nodes already on the canvas;
    # edges are always citing → cited with relation_type "cited_by".
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    group_keys: list[str]
    range_start: int
    range_end: int  # exclusive
    range_size: int
    max_results: int
    total_available: int  # eligible groups after exclusion (exact or estimate)
    total_exact: bool
    total_capped: bool
    provider_total: int | None  # OpenAlex meta.count, for "first 10,000 of N"
    scanned: int  # raw provider records scanned
    has_more: bool
    exhausted: bool  # the whole eligible list fits in this range
    clamped: bool
    scan_incomplete: bool  # the scan budget ran out before the range filled
    snapshot_id: str | None
    reason: Literal["no_provider_id"] | None = None


class TopUpSource(BaseModel):
    source_key: PaperKey
    source_group_key: GroupKey
    # Unpinned members of the (source, direction, order) branch on the canvas.
    connected_group_keys: list[GroupKey] = Field(default_factory=list, max_length=60)


class TopUpRequest(BaseModel):
    """Expand pinned nodes: bring each source's branch up to
    ``target_per_source`` connected papers (at most the range size)."""

    direction: RelationDirection = "cited_by"
    order: CitingOrder = "cited_by_count"
    target_per_source: int = Field(30, ge=1)
    exclude_group_keys: list[GroupKey] = Field(default_factory=list, max_length=500)
    sources: list[TopUpSource] = Field(min_length=1, max_length=20)


class TopUpSourceResult(BaseModel):
    source_key: str
    source_group_key: str
    added_group_keys: list[str]  # rank order
    connected_count: int  # unpinned connected papers after the top-up
    total_available: int
    total_exact: bool
    total_capped: bool
    provider_total: int | None
    exhausted: bool  # no eligible paper outside the connected ones remains
    reason: Literal["no_provider_id"] | None = None
    error: Literal["provider_unavailable", "timeout"] | None = None


class TopUpResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    sources: list[TopUpSourceResult]
    range_size: int
    max_results: int
