"""production security, sessions, account lifecycle, and encrypted Zotero credentials

Revision ID: c7d8e9f0a1b2
Revises: a1b2c3d4e5f6
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from app.common.crypto import keyring
from app.config import settings

revision: str = "c7d8e9f0a1b2"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Case collisions must be resolved explicitly; PostgreSQL rolls the whole upgrade back.
    op.execute(sa.text("UPDATE users SET email = lower(trim(email))"))
    op.add_column(
        "users", sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "users", sa.Column("terms_accepted_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("users", sa.Column("terms_version", sa.String(50), nullable=True))
    op.add_column(
        "users", sa.Column("privacy_acknowledged_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("users", sa.Column("privacy_version", sa.String(50), nullable=True))
    op.execute(
        sa.text("UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL")
    )

    op.add_column(
        "collection_members", sa.Column("joined_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute(
        sa.text(
            "UPDATE collection_members cm SET joined_at = c.created_at FROM collections c WHERE c.id = cm.collection_id"
        )
    )
    op.alter_column(
        "collection_members", "joined_at", nullable=False, server_default=sa.text("now()")
    )

    op.add_column(
        "zotero_credentials", sa.Column("api_key_ciphertext", sa.LargeBinary(), nullable=True)
    )
    op.add_column(
        "zotero_credentials", sa.Column("api_key_nonce", sa.LargeBinary(12), nullable=True)
    )
    op.add_column(
        "zotero_credentials", sa.Column("api_key_version", sa.SmallInteger(), nullable=True)
    )
    op.add_column("zotero_credentials", sa.Column("api_key_last_four", sa.String(4), nullable=True))
    bind = op.get_bind()
    rows = (
        bind.execute(sa.text("SELECT user_id, api_key FROM zotero_credentials FOR UPDATE"))
        .mappings()
        .all()
    )
    if rows and not settings.app_encryption_keys_file:
        raise RuntimeError(
            "APP_ENCRYPTION_KEYS_FILE is required to migrate existing Zotero credentials"
        )
    for row in rows:
        aad = f"zotero:{row['user_id']}"
        encrypted = keyring.encrypt(row["api_key"], purpose="zotero", aad=aad)
        if keyring.decrypt(encrypted, purpose="zotero", aad=aad) != row["api_key"]:
            raise RuntimeError("Zotero credential encryption verification failed")
        bind.execute(
            sa.text(
                "UPDATE zotero_credentials SET api_key_ciphertext=:ciphertext, api_key_nonce=:nonce, api_key_version=:version, api_key_last_four=:last_four WHERE user_id=:user_id"
            ),
            {
                "ciphertext": encrypted.ciphertext,
                "nonce": encrypted.nonce,
                "version": encrypted.key_version,
                "last_four": row["api_key"][-4:],
                "user_id": row["user_id"],
            },
        )
    for column in ("api_key_ciphertext", "api_key_nonce", "api_key_version", "api_key_last_four"):
        op.alter_column("zotero_credentials", column, nullable=False)
    op.drop_column("zotero_credentials", "api_key")

    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("family_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("token_digest", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("replaced_by_id", sa.UUID(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["replaced_by_id"], ["auth_sessions.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_digest"),
    )
    for name, columns in (
        ("ix_auth_sessions_family_id", ["family_id"]),
        ("ix_auth_sessions_user_id", ["user_id"]),
        ("ix_auth_sessions_token_digest", ["token_digest"]),
        ("ix_auth_sessions_expires_at", ["expires_at"]),
        ("ix_auth_sessions_revoked_at", ["revoked_at"]),
    ):
        op.create_index(name, "auth_sessions", columns)

    op.create_table(
        "user_action_tokens",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("token_digest", sa.String(64), nullable=False),
        sa.Column("email_target", sa.String(255), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_digest"),
    )
    op.create_index("ix_user_action_tokens_user_id", "user_action_tokens", ["user_id"])
    op.create_index("ix_user_action_tokens_token_digest", "user_action_tokens", ["token_digest"])
    op.create_index("ix_user_action_tokens_expires_at", "user_action_tokens", ["expires_at"])
    op.create_index("ix_action_user_purpose", "user_action_tokens", ["user_id", "purpose"])

    op.create_table(
        "email_outbox",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("payload_ciphertext", sa.LargeBinary(), nullable=True),
        sa.Column("payload_nonce", sa.LargeBinary(12), nullable=True),
        sa.Column("key_version", sa.Integer(), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_email_outbox_next_attempt_at", "email_outbox", ["next_attempt_at"])

    op.create_table(
        "account_deletion_tombstones",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "deleted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.create_index(
        "ix_account_deletion_tombstones_expires_at", "account_deletion_tombstones", ["expires_at"]
    )


def downgrade() -> None:
    raise RuntimeError(
        "This migration cannot restore plaintext credentials. Restore the verified pre-migration backup in maintenance mode."
    )
