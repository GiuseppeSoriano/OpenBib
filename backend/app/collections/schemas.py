"""Collection Pydantic schemas."""

import uuid
from datetime import datetime
from enum import Enum
from typing import Annotated

from pydantic import BaseModel, Field

from app.papers.schemas import PaperMetadataRead


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
    paper_canonical_key: str = Field(max_length=512)


class IdentifierImport(BaseModel):
    dois: list[Annotated[str, Field(min_length=1, max_length=512)]] = Field(
        default_factory=list, max_length=500
    )


class KeyImport(BaseModel):
    keys: list[Annotated[str, Field(min_length=1, max_length=512)]] = Field(
        default_factory=list, max_length=500
    )


class CollectionPaperRead(BaseModel):
    paper_canonical_key: str
    paper_group_key: str | None = None
    position: int
    added_at: datetime
    paper: PaperMetadataRead | None = None

    model_config = {"from_attributes": True}
