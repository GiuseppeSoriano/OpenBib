"""Preserve Semantic Scholar paper identities in durable metadata."""

import sqlalchemy as sa

from alembic import op

revision = "d6e7f8a9b0c1"
down_revision = "c7d8e9f0a1b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("cached_paper_metadata", sa.Column("semantic_scholar_id", sa.String(64)))
    op.create_index(
        "ix_cached_paper_metadata_semantic_scholar_id",
        "cached_paper_metadata",
        ["semantic_scholar_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_cached_paper_metadata_semantic_scholar_id", "cached_paper_metadata")
    op.drop_column("cached_paper_metadata", "semantic_scholar_id")
