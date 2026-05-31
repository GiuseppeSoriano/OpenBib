"""Collection Pydantic schemas."""

import uuid
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


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
    description: str | None = None
    visibility: Visibility = Visibility.private


class CollectionUpdate(BaseModel):
    name: str | None = Field(None, max_length=200)
    description: str | None = None
    visibility: Visibility | None = None


class CollectionRead(BaseModel):
    id: uuid.UUID
    owner_id: uuid.UUID
    name: str
    description: str | None
    visibility: str
    created_at: datetime
    paper_count: int = 0

    model_config = {"from_attributes": True}


class MemberAdd(BaseModel):
    user_id: uuid.UUID
    role: Role = Role.viewer


class PaperAdd(BaseModel):
    paper_canonical_key: str = Field(max_length=512)


class CollectionPaperRead(BaseModel):
    paper_canonical_key: str
    paper_group_key: str | None = None
    position: int
    added_at: datetime

    model_config = {"from_attributes": True}
