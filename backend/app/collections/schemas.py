"""Collection Pydantic schemas."""

import uuid
from datetime import datetime
from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

from app.papers.schemas import PaperMetadataRead, clean_title_value


class Visibility(str, Enum):
    private = "private"
    shared = "shared"
    public = "public"


class Role(str, Enum):
    owner = "owner"
    editor = "editor"
    viewer = "viewer"


class CollectionCreate(BaseModel):
    name: str = Field(max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    visibility: Visibility = Visibility.private


class CollectionUpdate(BaseModel):
    name: str | None = Field(None, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    visibility: Visibility | None = None


class CollectionRead(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    visibility: str
    created_at: datetime
    paper_count: int = 0
    is_owner: bool = False
    can_edit: bool = False

    model_config = {"from_attributes": True}


class MemberAdd(BaseModel):
    user_id: uuid.UUID
    role: Role = Role.viewer


class PaperAdd(BaseModel):
    paper_canonical_key: str = Field(
        min_length=1,
        max_length=512,
        description="DOI, doi:…, https://doi.org/… or an existing hash: key",
    )


# Blank lines are allowed here and dropped by the import service.
class IdentifierImport(BaseModel):
    dois: list[Annotated[str, Field(max_length=512)]] = Field(default_factory=list, max_length=500)


class KeyImport(BaseModel):
    keys: list[Annotated[str, Field(max_length=512)]] = Field(default_factory=list, max_length=500)


class CollectionPaperRead(BaseModel):
    paper_canonical_key: str
    paper_group_key: str | None = None
    position: int
    added_at: datetime
    paper: PaperMetadataRead | None = None
    # False while the paper is stored as pending (providers unavailable).
    resolved: bool

    model_config = {"from_attributes": True}


class ImportLineResult(BaseModel):
    line: int  # 1-based index within the request list
    input: str
    status: Literal["added", "duplicate", "invalid", "not_found", "unresolved"]
    canonical_key: str | None = None
    title: str | None = None

    _clean_title = field_validator("title", mode="before")(clean_title_value)


class ImportResult(BaseModel):
    added: int
    duplicate: int
    invalid: int
    not_found: int
    unresolved: int
    total: int
    skipped: int  # deprecated alias of ``duplicate``
    results: list[ImportLineResult]
