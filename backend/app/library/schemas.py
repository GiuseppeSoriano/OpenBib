"""Library Pydantic schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.common.identifiers import PaperKey
from app.papers.schemas import PaperMetadataRead, StateRead


class LibraryVersionPin(BaseModel):
    paper_canonical_key: str
    paper_group_key: str
    source_provider: str | None = None
    added_at: datetime

    model_config = {"from_attributes": True}


class LibraryEntryEnsure(BaseModel):
    """Idempotent create — the frontend always knows both keys because it
    just rendered them, so we never have to fetch metadata server-side.
    Cached metadata still wins over a mismatching ``paper_group_key``."""

    paper_group_key: str = Field(max_length=512, pattern=r"^group:\S+$")
    paper_canonical_key: PaperKey
    source_provider: str | None = Field(default=None, max_length=50)


class LibraryVersionAdd(BaseModel):
    paper_canonical_key: PaperKey
    source_provider: str | None = Field(default=None, max_length=50)


class LibraryEntryRepin(BaseModel):
    primary_canonical_key: PaperKey


class LibraryEntryRead(BaseModel):
    paper_group_key: str
    primary_canonical_key: str
    created_at: datetime
    primary_version: PaperMetadataRead | None = None
    pinned_versions: list[LibraryVersionPin] = []
    notes_count: int = 0
    tags: list[str] = []
    states: list[StateRead] = []


class LibraryEntryListItem(BaseModel):
    paper_group_key: str
    primary_canonical_key: str
    created_at: datetime
    primary_version: PaperMetadataRead | None = None
    # False while the primary version has no cached metadata.
    resolved: bool
    version_count: int = 1
    tags: list[str] = []


class LibraryEntryPage(BaseModel):
    items: list[LibraryEntryListItem]
    total: int
    page: int
    size: int


class TagFacet(BaseModel):
    tag: str
    count: int


class StateFacet(BaseModel):
    state: str
    count: int


class LibraryFacets(BaseModel):
    tags: list[TagFacet] = []
    states: list[StateFacet] = []
    total: int
    unresolved: int


class LibraryKeysResponse(BaseModel):
    paper_group_keys: list[str] = []


class LibraryResolve(BaseModel):
    """Retry or correct a stored paper key. ``paper_canonical_key`` is the key
    exactly as stored (not normalized); ``replacement`` is a corrected
    identifier in any form a collection add accepts (DOI or DOI link, ``s2:``
    key or Semantic Scholar link, arXiv ID, ``pmid:``/``pmcid:``, known
    ``hash:`` key)."""

    paper_canonical_key: str = Field(min_length=1, max_length=512)
    replacement: str | None = Field(default=None, min_length=1, max_length=512)


class LibraryResolveRead(BaseModel):
    status: Literal["resolved", "not_found", "unavailable"]
    previous_key: str
    # Effective key after re-keying (equal to previous_key when unchanged).
    canonical_key: str
    # Effective Library group; None when the caller has no pin for the paper.
    paper_group_key: str | None = None
    paper: PaperMetadataRead | None = None
    # Rows touched per table.
    moved: dict[str, int] = {}
