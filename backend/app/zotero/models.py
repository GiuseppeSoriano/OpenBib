"""Zotero sync SQLAlchemy models — per-user credentials + local↔Zotero links."""

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, LargeBinary, SmallInteger, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ZoteroCredentials(Base):
    """Per-user Zotero Web API credentials.

    AES-GCM ciphertext is bound to the user and key version. Only the last
    four characters are exposed as a connection hint.
    """

    __tablename__ = "zotero_credentials"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    api_key_ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    api_key_nonce: Mapped[bytes] = mapped_column(LargeBinary(12), nullable=False)
    api_key_version: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    api_key_last_four: Mapped[str] = mapped_column(String(4), nullable=False)
    zotero_user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ZoteroLink(Base):
    """Mapping between a local object and its Zotero counterpart.

    local_type: 'collection' (local_key = collection UUID string, or the
    'library' sentinel) or 'paper' (local_key = paper canonical key).
    The mapping is what makes sync idempotent: linked objects are updated
    in place, never re-created.
    """

    __tablename__ = "zotero_links"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    local_type: Mapped[str] = mapped_column(String(20), primary_key=True)
    local_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    zotero_key: Mapped[str] = mapped_column(String(16), nullable=False)
    zotero_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_synced_at: Mapped[datetime] = mapped_column(
        nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (Index("ix_zotero_links_user_type", "user_id", "local_type"),)
