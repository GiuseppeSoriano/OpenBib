"""add user_dismissed_papers table

Revision ID: b1c2d3e4f5a6
Revises: 0a87f53b66fe
Create Date: 2026-04-09 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b1c2d3e4f5a6"
down_revision: str | None = "0a87f53b66fe"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_dismissed_papers",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("paper_canonical_key", sa.String(length=512), nullable=False),
        sa.Column("dismissed_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "paper_canonical_key"),
    )


def downgrade() -> None:
    op.drop_table("user_dismissed_papers")
