"""Paper-related SQLAlchemy models — user states, tags, preferences."""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

READING_STATES = (
    "unseen",
    "seen",
    "saved",
    "to_read",
    "reading",
    "read",
    "important",
    "ignored",
    "excluded",
)


class UserPaperState(Base):
    __tablename__ = "user_paper_states"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    paper_canonical_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    state: Mapped[str] = mapped_column(
        Enum(*READING_STATES, name="reading_state_enum"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class UserPaperTag(Base):
    __tablename__ = "user_paper_tags"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    paper_canonical_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    tag: Mapped[str] = mapped_column(String(100), primary_key=True)
    paper_group_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    __table_args__ = (Index("ix_user_paper_tags_user_group", "user_id", "paper_group_key"),)


class UserDismissedPaper(Base):
    __tablename__ = "user_dismissed_papers"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    paper_canonical_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    dismissed_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class UserPreference(Base):
    __tablename__ = "user_preferences"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value_json: Mapped[dict] = mapped_column(
        JSON().with_variant(JSONB(), "postgresql"), nullable=False
    )


class CachedPaperMetadata(Base):
    __tablename__ = "cached_paper_metadata"

    canonical_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    paper_group_key: Mapped[str] = mapped_column(String(512), index=True, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    authors_json: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    abstract: Mapped[str | None] = mapped_column(Text)
    publication_date: Mapped[date | None] = mapped_column(Date)
    doi: Mapped[str | None] = mapped_column(String(512))
    arxiv_id: Mapped[str | None] = mapped_column(String(255))
    pmid: Mapped[str | None] = mapped_column(String(255))
    pmcid: Mapped[str | None] = mapped_column(String(255))
    openalex_id: Mapped[str | None] = mapped_column(String(255))
    venue: Mapped[str | None] = mapped_column(String(512))
    volume: Mapped[str | None] = mapped_column(String(100))
    issue: Mapped[str | None] = mapped_column(String(100))
    pages: Mapped[str | None] = mapped_column(String(100))
    paper_type: Mapped[str | None] = mapped_column(String(100))
    topics_json: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    keywords_json: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    open_access: Mapped[bool | None] = mapped_column(Boolean)
    pdf_url: Mapped[str | None] = mapped_column(String(1024))
    abstract_url: Mapped[str | None] = mapped_column(String(1024))
    cited_by_count: Mapped[int | None] = mapped_column(Integer)
    reference_count: Mapped[int | None] = mapped_column(Integer)
    version: Mapped[str | None] = mapped_column(String(50))
    provider_source: Mapped[str] = mapped_column(String(50), nullable=False)
    provider_sources_json: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )
