"""add provider_sources_json to cached_paper_metadata

Revision ID: d3a5b7e8c9f1
Revises: c2f4d6a8b9e0
Create Date: 2026-05-03 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d3a5b7e8c9f1"
down_revision: str | None = "c2f4d6a8b9e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "cached_paper_metadata",
        sa.Column("provider_sources_json", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("cached_paper_metadata", "provider_sources_json")
