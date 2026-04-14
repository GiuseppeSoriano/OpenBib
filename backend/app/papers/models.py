"""Paper-related SQLAlchemy models — user states, tags, preferences."""

import uuid
from datetime import datetime

from sqlalchemy import Enum, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

READING_STATES = (
    "unseen", "seen", "saved", "to_read", "reading", "read", "important", "ignored", "excluded"
)


class UserPaperState(Base):
    __tablename__ = "user_paper_states"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    paper_canonical_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    collection_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("collections.id", ondelete="CASCADE"), primary_key=True, nullable=True
    )
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
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


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
    value_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
