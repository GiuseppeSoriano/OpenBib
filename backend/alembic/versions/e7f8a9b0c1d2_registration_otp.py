"""Temporary registration challenges; retire initial email-verification links."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "e7f8a9b0c1d2"
down_revision = "d6e7f8a9b0c1"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "registration_challenges",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("locale", sa.String(2), nullable=False),
        sa.Column("cookie_digest", sa.String(64), nullable=False, unique=True),
        sa.Column("otp_digest", sa.String(64), nullable=False),
        sa.Column("key_version", sa.Integer(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        *[
            sa.Column(name, sa.DateTime(timezone=True), nullable=False)
            for name in ("otp_expires_at", "resend_at", "expires_at")
        ],
        sa.Column("verified_at", sa.DateTime(timezone=True)),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_registration_challenges_email", "registration_challenges", ["email"])
    op.create_index(
        "ix_registration_challenges_expires_at", "registration_challenges", ["expires_at"]
    )
    op.execute(
        "UPDATE user_action_tokens SET used_at = CURRENT_TIMESTAMP WHERE purpose = 'verify_email' AND used_at IS NULL"
    )


def downgrade():
    op.drop_table("registration_challenges")
    # Consumed verification links deliberately remain invalid after downgrade.
