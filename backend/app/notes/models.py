"""Note SQLAlchemy model."""

import uuid
from datetime import datetime

from sqlalchemy import Enum, ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    target_type: Mapped[str] = mapped_column(
        Enum("paper", "collection", "author", name="note_target_enum"), nullable=False
    )
    target_key: Mapped[str] = mapped_column(String(512), nullable=False)
    paper_group_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    __table_args__ = (
        Index("ix_notes_user_target", "user_id", "target_type", "target_key"),
        Index("ix_notes_user_group", "user_id", "paper_group_key"),
    )
