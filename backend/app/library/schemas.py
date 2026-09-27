"""Library Pydantic schemas."""

from __future__ import annotations

from datetime import datetime

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
    version_count: int = 1
    tags: list[str] = []


class LibraryKeysResponse(BaseModel):
    paper_group_keys: list[str] = []
