"""normalize legacy raw-DOI paper keys

Revision ID: 1d2e3f4a5b6c
Revises: f8a9b0c1d2e3

Data-only repair: paper keys stored before identifiers were normalized (bare
DOIs, ``DOI:``-labelled keys, doi.org links) are re-keyed to ``doi:<lowercase
doi>`` in every key-bearing table and merged with rows already stored under
that key. See ``app.common.key_repair``; preview the same repair with
``python -m scripts.repair_paper_keys --dry-run``. Take a database backup
before upgrading: the merge cannot be undone.
"""

import logging
from collections.abc import Sequence

from alembic import op
from app.common.key_repair import repair_paper_keys

revision: str = "1d2e3f4a5b6c"
down_revision: str | None = "f8a9b0c1d2e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# alembic.ini shows INFO only for the "alembic" logger tree.
log = logging.getLogger("alembic.runtime.migration")


def upgrade() -> None:
    report = repair_paper_keys(op.get_bind())
    # Counts only: paper keys can reveal what a user reads.
    log.info(
        "Paper key repair: %d keys mapped, %d unrepairable; rows touched: %s",
        report.mapped,
        len(report.unrepairable),
        ", ".join(f"{table}={count}" for table, count in report.counts.items()) or "none",
    )


def downgrade() -> None:
    """No-op: the repair merges rows and cannot be reversed. Restore the
    backup taken before the upgrade to get the old keys back."""
