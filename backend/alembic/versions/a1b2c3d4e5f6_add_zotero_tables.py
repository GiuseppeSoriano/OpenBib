"""add zotero_credentials and zotero_links tables

Revision ID: a1b2c3d4e5f6
Revises: f5c8d9e0a1b3
Create Date: 2026-07-05 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "f5c8d9e0a1b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "zotero_credentials",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("api_key", sa.String(length=128), nullable=False),
        sa.Column("zotero_user_id", sa.String(length=32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )

    op.create_table(
        "zotero_links",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("local_type", sa.String(length=20), nullable=False),
        sa.Column("local_key", sa.String(length=512), nullable=False),
        sa.Column("zotero_key", sa.String(length=16), nullable=False),
        sa.Column("zotero_version", sa.Integer(), nullable=True),
        sa.Column(
            "last_synced_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "local_type", "local_key"),
    )
    op.create_index("ix_zotero_links_user_type", "zotero_links", ["user_id", "local_type"])


def downgrade() -> None:
    op.drop_index("ix_zotero_links_user_type", table_name="zotero_links")
    op.drop_table("zotero_links")
    op.drop_table("zotero_credentials")
