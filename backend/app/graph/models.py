"""Graph edge SQLAlchemy model."""

from datetime import datetime

from sqlalchemy import Enum, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

RELATION_TYPES = ("cites", "cited_by", "similar_to", "authored_by", "co_authored", "version_of")


class PaperGraphEdge(Base):
    __tablename__ = "paper_graph_edges"

    source_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    target_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    relation_type: Mapped[str] = mapped_column(
        Enum(*RELATION_TYPES, name="relation_type_enum"), primary_key=True
    )
    provider_source: Mapped[str] = mapped_column(String(50), nullable=False)
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    __table_args__ = (
        Index("ix_graph_source", "source_key"),
        Index("ix_graph_target", "target_key"),
        Index("ix_graph_relation", "relation_type"),
    )
