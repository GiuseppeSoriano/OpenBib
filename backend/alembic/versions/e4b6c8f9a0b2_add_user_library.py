"""add user_library_entries and user_library_versions tables

Revision ID: e4b6c8f9a0b2
Revises: d3a5b7e8c9f1
Create Date: 2026-05-05 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e4b6c8f9a0b2"
down_revision: str | None = "d3a5b7e8c9f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_library_entries",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("paper_group_key", sa.String(length=512), nullable=False),
        sa.Column("primary_canonical_key", sa.String(length=512), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "paper_group_key"),
    )

    op.create_table(
        "user_library_versions",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("paper_canonical_key", sa.String(length=512), nullable=False),
        sa.Column("paper_group_key", sa.String(length=512), nullable=False),
        sa.Column("source_provider", sa.String(length=50), nullable=True),
        sa.Column(
            "added_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["user_id", "paper_group_key"],
            ["user_library_entries.user_id", "user_library_entries.paper_group_key"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", "paper_canonical_key"),
    )
    op.create_index(
        "ix_user_library_versions_user_group",
        "user_library_versions",
        ["user_id", "paper_group_key"],
    )


def downgrade() -> None:
    op.drop_index("ix_user_library_versions_user_group", table_name="user_library_versions")
    op.drop_table("user_library_versions")
    op.drop_table("user_library_entries")
