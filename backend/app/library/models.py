"""Library SQLAlchemy models — per-user persistent paper archive."""

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, ForeignKeyConstraint, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserLibraryEntry(Base):
    """One row per (user, logical paper). Anchors notes/tags to the
    paper_group_key so they survive version upgrades and collection moves.
    """

    __tablename__ = "user_library_entries"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    paper_group_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    primary_canonical_key: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class UserLibraryVersion(Base):
    """A specific version (canonical_key) the user has explicitly pinned
    under a library entry. Saving v1 (preprint) and later v3 (published)
    leaves both versions explicitly tracked."""

    __tablename__ = "user_library_versions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    paper_canonical_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    paper_group_key: Mapped[str] = mapped_column(String(512), nullable=False)
    source_provider: Mapped[str | None] = mapped_column(String(50), nullable=True)
    added_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    __table_args__ = (
        ForeignKeyConstraint(
            ("user_id", "paper_group_key"),
            ("user_library_entries.user_id", "user_library_entries.paper_group_key"),
            ondelete="CASCADE",
        ),
        Index("ix_user_library_versions_user_group", "user_id", "paper_group_key"),
    )
