"""add cached paper metadata

Revision ID: c2f4d6a8b9e0
Revises: b1c2d3e4f5a6
Create Date: 2026-04-18 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c2f4d6a8b9e0"
down_revision: str | None = "b1c2d3e4f5a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "cached_paper_metadata",
        sa.Column("canonical_key", sa.String(length=512), nullable=False),
        sa.Column("paper_group_key", sa.String(length=512), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("authors_json", sa.JSON(), nullable=False),
        sa.Column("abstract", sa.Text(), nullable=True),
        sa.Column("publication_date", sa.Date(), nullable=True),
        sa.Column("doi", sa.String(length=512), nullable=True),
        sa.Column("arxiv_id", sa.String(length=255), nullable=True),
        sa.Column("pmid", sa.String(length=255), nullable=True),
        sa.Column("pmcid", sa.String(length=255), nullable=True),
        sa.Column("openalex_id", sa.String(length=255), nullable=True),
        sa.Column("venue", sa.String(length=512), nullable=True),
        sa.Column("volume", sa.String(length=100), nullable=True),
        sa.Column("issue", sa.String(length=100), nullable=True),
        sa.Column("pages", sa.String(length=100), nullable=True),
        sa.Column("paper_type", sa.String(length=100), nullable=True),
        sa.Column("topics_json", sa.JSON(), nullable=False),
        sa.Column("keywords_json", sa.JSON(), nullable=False),
        sa.Column("open_access", sa.Boolean(), nullable=True),
        sa.Column("pdf_url", sa.String(length=1024), nullable=True),
        sa.Column("abstract_url", sa.String(length=1024), nullable=True),
        sa.Column("cited_by_count", sa.Integer(), nullable=True),
        sa.Column("reference_count", sa.Integer(), nullable=True),
        sa.Column("version", sa.String(length=50), nullable=True),
        sa.Column("provider_source", sa.String(length=50), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("canonical_key"),
    )
    op.create_index(
        "ix_cached_paper_metadata_paper_group_key",
        "cached_paper_metadata",
        ["paper_group_key"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_cached_paper_metadata_paper_group_key", table_name="cached_paper_metadata")
    op.drop_table("cached_paper_metadata")
