"""Note Pydantic schemas."""

import uuid
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class TargetType(str, Enum):
    paper = "paper"
    collection = "collection"
    author = "author"


class NoteCreate(BaseModel):
    target_type: TargetType
    target_key: str = Field(max_length=512)
    content: str = Field(min_length=1)


class NoteUpdate(BaseModel):
    content: str = Field(min_length=1)


class NoteRead(BaseModel):
    id: uuid.UUID
    target_type: str
    target_key: str
    paper_group_key: str | None = None
    content: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
