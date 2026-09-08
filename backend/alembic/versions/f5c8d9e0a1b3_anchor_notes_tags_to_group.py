"""anchor notes/tags to paper_group_key + narrow user_paper_states PK

Revision ID: f5c8d9e0a1b3
Revises: e4b6c8f9a0b2
Create Date: 2026-05-05 12:30:00.000000

Step 1 — add nullable paper_group_key to notes and user_paper_tags, then
backfill via lookup against cached_paper_metadata. Rows whose canonical_key
hasn't been cached yet remain NULL and are lazily reconciled by the service
layer on next read.

Step 2 — dedupe user_paper_states rows that disagree across collections for
the same (user, canonical_key), keeping the most-progressed reading state per
the user-perceived order important > read > reading > to_read > saved > seen
> unseen > ignored > excluded. Then drop collection_id from the PK and the
column itself, so reading state becomes Library-global per version.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f5c8d9e0a1b3"
down_revision: str | None = "e4b6c8f9a0b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Order is "most progressed first": when collapsing duplicate rows, the
# first match in this list wins.
_STATE_PRIORITY = (
    "important",
    "read",
    "reading",
    "to_read",
    "saved",
    "seen",
    "unseen",
    "ignored",
    "excluded",
)


def _drop_states_collection_fk(bind) -> None:
    """Drop the FK on user_paper_states.collection_id by introspecting its
    real name. The constraint name varies across dialects and historical
    deployments, so we look it up from information_schema rather than guess.
    """
    inspector = sa.inspect(bind)
    for fk in inspector.get_foreign_keys("user_paper_states"):
        if "collection_id" in fk.get("constrained_columns", []):
            op.drop_constraint(fk["name"], "user_paper_states", type_="foreignkey")
            return


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    # ------------------------------------------------------------------
    # notes — add paper_group_key + index, backfill from cached_paper_metadata
    # ------------------------------------------------------------------
    op.add_column(
        "notes",
        sa.Column("paper_group_key", sa.String(length=512), nullable=True),
    )
    op.create_index("ix_notes_user_group", "notes", ["user_id", "paper_group_key"])

    if dialect == "postgresql":
        bind.execute(
            sa.text(
                """
                UPDATE notes
                   SET paper_group_key = cpm.paper_group_key
                  FROM cached_paper_metadata AS cpm
                 WHERE notes.target_type = 'paper'
                   AND notes.target_key = cpm.canonical_key
                   AND notes.paper_group_key IS NULL
                """
            )
        )
    else:
        # SQLite (test runner) — UPDATE-FROM dialect differs, use correlated subquery.
        bind.execute(
            sa.text(
                """
                UPDATE notes
                   SET paper_group_key = (
                       SELECT paper_group_key FROM cached_paper_metadata
                        WHERE canonical_key = notes.target_key
                   )
                 WHERE notes.target_type = 'paper'
                   AND notes.paper_group_key IS NULL
                """
            )
        )

    # ------------------------------------------------------------------
    # user_paper_tags — add paper_group_key + index, backfill
    # ------------------------------------------------------------------
    op.add_column(
        "user_paper_tags",
        sa.Column("paper_group_key", sa.String(length=512), nullable=True),
    )
    op.create_index(
        "ix_user_paper_tags_user_group",
        "user_paper_tags",
        ["user_id", "paper_group_key"],
    )

    if dialect == "postgresql":
        bind.execute(
            sa.text(
                """
                UPDATE user_paper_tags
                   SET paper_group_key = cpm.paper_group_key
                  FROM cached_paper_metadata AS cpm
                 WHERE user_paper_tags.paper_canonical_key = cpm.canonical_key
                   AND user_paper_tags.paper_group_key IS NULL
                """
            )
        )
    else:
        bind.execute(
            sa.text(
                """
                UPDATE user_paper_tags
                   SET paper_group_key = (
                       SELECT paper_group_key FROM cached_paper_metadata
                        WHERE canonical_key = user_paper_tags.paper_canonical_key
                   )
                 WHERE user_paper_tags.paper_group_key IS NULL
                """
            )
        )

    # ------------------------------------------------------------------
    # user_paper_states — dedupe, drop FK, drop column, narrow PK
    # ------------------------------------------------------------------
    rows = bind.execute(
        sa.text(
            """
            SELECT user_id, paper_canonical_key, state, updated_at
              FROM user_paper_states
            """
        )
    ).fetchall()

    survivors: list[dict] = []
    if rows:
        priority = {state: rank for rank, state in enumerate(_STATE_PRIORITY)}
        winners: dict[tuple, tuple] = {}
        for r in rows:
            key = (r.user_id, r.paper_canonical_key)
            current = winners.get(key)
            new_rank = priority.get(r.state, len(_STATE_PRIORITY))
            if current is None or new_rank < current[1]:
                winners[key] = (r.state, new_rank, r.updated_at)
        survivors = [
            {
                "user_id": user_id,
                "paper_canonical_key": canonical_key,
                "state": state,
                "updated_at": updated_at,
            }
            for (user_id, canonical_key), (state, _rank, updated_at) in winners.items()
        ]
        op.execute("DELETE FROM user_paper_states")

    _drop_states_collection_fk(bind)
    with op.batch_alter_table("user_paper_states") as batch:
        batch.drop_constraint("user_paper_states_pkey", type_="primary")
        batch.drop_column("collection_id")
        batch.create_primary_key("user_paper_states_pkey", ["user_id", "paper_canonical_key"])

    if survivors:
        bind.execute(
            sa.text(
                """
                INSERT INTO user_paper_states
                    (user_id, paper_canonical_key, state, updated_at)
                VALUES (:user_id, :paper_canonical_key, :state, :updated_at)
                """
            ),
            survivors,
        )


def downgrade() -> None:
    # Rebuild collection_id column + PK on user_paper_states. Surviving rows
    # all get NULL collection_id (data-loss for the per-collection scoping
    # that existed before the upgrade — acceptable in a downgrade scenario).
    with op.batch_alter_table("user_paper_states") as batch:
        batch.drop_constraint("user_paper_states_pkey", type_="primary")
        batch.add_column(sa.Column("collection_id", sa.UUID(), nullable=True))
        batch.create_foreign_key(
            "user_paper_states_collection_id_fkey",
            "collections",
            ["collection_id"],
            ["id"],
            ondelete="CASCADE",
        )
        batch.create_primary_key(
            "user_paper_states_pkey",
            ["user_id", "paper_canonical_key", "collection_id"],
        )

    op.drop_index("ix_user_paper_tags_user_group", table_name="user_paper_tags")
    op.drop_column("user_paper_tags", "paper_group_key")

    op.drop_index("ix_notes_user_group", table_name="notes")
    op.drop_column("notes", "paper_group_key")
