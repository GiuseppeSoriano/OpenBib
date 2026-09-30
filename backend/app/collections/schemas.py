"""Collection Pydantic schemas."""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.papers.schemas import PaperMetadataRead, clean_title_value


class CollectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    model_config = ConfigDict(extra="forbid")


class CollectionUpdate(BaseModel):
    name: str | None = Field(None, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    revision: int = Field(ge=1)
    model_config = ConfigDict(extra="forbid")


class CollectionRead(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    revision: int
    created_at: datetime
    paper_count: int = 0
    is_owner: bool = False
    can_edit: bool = False
    can_manage_access: bool = False

    model_config = {"from_attributes": True}


class MemberAdd(BaseModel):
    email: EmailStr
    model_config = ConfigDict(extra="forbid")

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value):
        from app.auth.schemas import _normalize_email

        return _normalize_email(value)


class MemberRead(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str
    role: str


class ReadLinkRead(BaseModel):
    enabled: bool
    url: str | None = None


class PaperAdd(BaseModel):
    paper_canonical_key: str = Field(
        min_length=1,
        max_length=512,
        description=(
            "DOI, doi:…, https://doi.org/…, s2:… or a semanticscholar.org link, an arXiv ID"
            " or link, pmid:…, pmcid:PMC…, or an existing hash: key"
        ),
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
    # ``unavailable``: not saved (the provider failed); the line can be retried.
    status: Literal["added", "duplicate", "invalid", "not_found", "unresolved", "unavailable"]
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
