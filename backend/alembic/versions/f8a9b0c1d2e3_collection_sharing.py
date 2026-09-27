"""Replace visibility with revocable read links and account collaboration.

Revision ID: f8a9b0c1d2e3
Revises: e7f8a9b0c1d2
"""

import sqlalchemy as sa

from alembic import op

revision = "f8a9b0c1d2e3"
down_revision = "e7f8a9b0c1d2"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "collections", sa.Column("revision", sa.Integer(), nullable=False, server_default="1")
    )
    op.add_column("collections", sa.Column("read_link_digest", sa.String(64)))
    op.add_column("collections", sa.Column("read_link_ciphertext", sa.LargeBinary()))
    op.add_column("collections", sa.Column("read_link_nonce", sa.LargeBinary()))
    op.add_column("collections", sa.Column("read_link_key_version", sa.Integer()))
    op.execute(
        "UPDATE collection_members m SET role='editor' FROM collections c WHERE m.collection_id=c.id AND m.user_id<>c.owner_id AND m.role='owner'"
    )
    op.drop_column("collections", "visibility")
    op.execute("DROP TYPE visibility_enum")


def downgrade():
    # Prior public visibility cannot safely be reconstructed: restore as private.
    visibility = sa.Enum("private", "shared", "public", name="visibility_enum")
    visibility.create(op.get_bind())
    op.add_column(
        "collections", sa.Column("visibility", visibility, nullable=False, server_default="private")
    )
    for name in (
        "read_link_key_version",
        "read_link_nonce",
        "read_link_ciphertext",
        "read_link_digest",
        "revision",
    ):
        op.drop_column("collections", name)
