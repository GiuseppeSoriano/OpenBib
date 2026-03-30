"""Paper Pydantic schemas."""

from datetime import date, datetime

from pydantic import BaseModel, Field


class PaperMetadataRead(BaseModel):
    canonical_key: str
    title: str
    authors: list[dict] = []
    abstract: str | None = None
    publication_date: date | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    pmid: str | None = None
    pmcid: str | None = None
    openalex_id: str | None = None
    venue: str | None = None
    paper_type: str | None = None
    topics: list[str] = []
    keywords: list[str] = []
    open_access: bool | None = None
    pdf_url: str | None = None
    cited_by_count: int | None = None
    reference_count: int | None = None
    provider_source: str | None = None


class StateUpdate(BaseModel):
    state: str
    collection_id: str | None = None


class StateRead(BaseModel):
    paper_canonical_key: str
    state: str
    collection_id: str | None = None
    updated_at: datetime

    model_config = {"from_attributes": True}


class TagCreate(BaseModel):
    tag: str = Field(max_length=100)


class TagRead(BaseModel):
    paper_canonical_key: str
    tag: str
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
