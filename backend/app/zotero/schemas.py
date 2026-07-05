"""Zotero Pydantic schemas."""

from pydantic import BaseModel, Field


class ZoteroCredentialsUpdate(BaseModel):
    api_key: str = Field(min_length=8, max_length=128)


class ZoteroCredentialsStatus(BaseModel):
    connected: bool
    zotero_user_id: str | None = None
    api_key_masked: str | None = None


class ZoteroSyncFailure(BaseModel):
    paper_canonical_key: str
    message: str


class ZoteroSyncReport(BaseModel):
    zotero_collection_key: str
    items_created: int = 0
    items_updated: int = 0
    items_skipped: int = 0
    failures: list[ZoteroSyncFailure] = []
