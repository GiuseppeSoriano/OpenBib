"""Paper Pydantic schemas."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.common.text import clean_inline_text, normalize_abstract


def clean_title_value(value: object) -> object:
    """``mode="before"`` validator body: clean provider markup out of a title.
    Rows cached before normalization existed (DB, Redis) are fixed on read."""
    return clean_inline_text(value) if isinstance(value, str) else value


def normalize_abstract_value(value: object) -> object:
    return normalize_abstract(value) if isinstance(value, str) else value


class AuthorRead(BaseModel):
    name: str
    family_name: str | None = None
    given_name: str | None = None
    semantic_scholar_id: str | None = None
    openalex_id: str | None = None
    orcid: str | None = None
    affiliations: list[str] = []


class PaperMetadataRead(BaseModel):
    canonical_key: str
    paper_group_key: str
    title: str
    authors: list[AuthorRead] = []
    abstract: str | None = None
    publication_date: date | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    pmid: str | None = None
    pmcid: str | None = None
    semantic_scholar_id: str | None = None
    openalex_id: str | None = None
    venue: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    paper_type: str | None = None
    topics: list[str] = []
    keywords: list[str] = []
    open_access: bool | None = None
    pdf_url: str | None = None
    abstract_url: str | None = None
    cited_by_count: int | None = None
    reference_count: int | None = None
    version: str | None = None
    provider_source: str | None = None
    provider_sources: list[str] = []

    _clean_title = field_validator("title", mode="before")(clean_title_value)
    _clean_abstract = field_validator("abstract", mode="before")(normalize_abstract_value)


class PaperDetailRead(PaperMetadataRead):
    """Full paper detail: primary metadata plus sibling versions of the
    same logical paper (shared paper_group_key)."""

    versions: list[PaperMetadataRead] = []


class PossibleVersionRead(BaseModel):
    """Another result that may be a version of this one. Never merged."""

    paper_group_key: str
    title: str
    provider_sources: list[str] = []

    _clean_title = field_validator("title", mode="before")(clean_title_value)


class SearchPaperItemRead(BaseModel):
    kind: Literal["paper"]
    paper: PaperMetadataRead
    possible_versions: list[PossibleVersionRead] = []


class SearchPaperGroupItemRead(BaseModel):
    kind: Literal["paper_group"]
    paper_group_key: str
    title: str
    authors: list[AuthorRead] = []
    version_count: int
    selected_version: PaperMetadataRead
    versions: list[PaperMetadataRead] = []
    provider_sources: list[str] = []
    possible_versions: list[PossibleVersionRead] = []

    _clean_title = field_validator("title", mode="before")(clean_title_value)


SearchSort = Literal["relevance", "date", "citations"]


class SearchResultRead(BaseModel):
    items: list[SearchPaperItemRead | SearchPaperGroupItemRead]
    total_count: int
    raw_total_count: int
    has_more: bool = False
    page: int
    page_size: int
    providers: list[str] = []
    sort: SearchSort = "relevance"
    # Opaque continuation of the date and citation sorts; None on the last page.
    next_cursor: str | None = None
    # The provider's own match count (an estimate), kept before deduplication.
    total_estimate: int | None = None
    # Paging stopped at the provider's result window (relevance: first 1,000).
    window_capped: bool = False
    # A filter (author) was applied to the served rows only.
    filtered_locally: bool = False
    # The provider that answered.
    source: str = "semantic_scholar"


class StateUpdate(BaseModel):
    state: str


class StateRead(BaseModel):
    paper_canonical_key: str
    state: str
    updated_at: datetime

    model_config = {"from_attributes": True}


class TagCreate(BaseModel):
    tag: str = Field(max_length=100)


class TagRead(BaseModel):
    paper_canonical_key: str
    tag: str
    paper_group_key: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class SearchQuery(BaseModel):
    q: str = Field(min_length=1, max_length=500)
    provider: str | None = None
    year_from: int | None = None
    year_to: int | None = None
    author: str | None = None
    open_access_only: bool = False
    page: int = Field(1, ge=1)
    size: int = Field(25, ge=1, le=100)
