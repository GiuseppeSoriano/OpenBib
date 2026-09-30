"""Preview or apply the legacy paper-key repair of migration 1d2e3f4a5b6c.

    docker compose run --rm api python -m scripts.repair_paper_keys --dry-run
    docker compose run --rm api python -m scripts.repair_paper_keys --apply

``--dry-run`` runs the whole repair in a transaction that is always rolled
back and prints the per-table counts plus the first unrepairable keys (such
as ``doi:not-a-doi``, which only the user can correct). ``--apply`` commits;
take a database backup first. Both are idempotent: once the repair has run,
the dry run reports ``keys mapped: 0``.

Keys of the other strong identifiers (``s2:``, ``arxiv:``, ``pmid:``,
``pmcid:``, ``openalex:``) are valid as stored: they are neither repaired
nor reported. A raw DOI whose paper is cached under an ``s2:`` key moves to
its ``doi:`` form, which reads resolve through the DOI alias; the user's
``POST /library/resolve`` then merges it onto the ``s2:`` key.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from app.common.key_repair import RepairReport, repair_paper_keys
from app.database import engine

MAX_LISTED = 50


async def run(*, apply: bool) -> RepairReport:
    try:
        async with engine.connect() as conn:
            report = await conn.run_sync(
                lambda sync_conn: repair_paper_keys(sync_conn, dry_run=not apply)
            )
            if apply:
                await conn.commit()
            else:
                await conn.rollback()
    finally:
        await engine.dispose()
    return report


def print_report(report: RepairReport, *, apply: bool) -> None:
    print("Mode: apply (committed)" if apply else "Mode: dry run (rolled back)")
    print(f"Keys mapped: {report.mapped}")
    for table, count in report.counts.items():
        print(f"  {table}: {count}")
    print(f"Unrepairable keys: {len(report.unrepairable)}")
    for key in report.unrepairable[:MAX_LISTED]:
        print(f"  {key}")
    if len(report.unrepairable) > MAX_LISTED:
        print(f"  … and {len(report.unrepairable) - MAX_LISTED} more")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Report only; always rolls back")
    mode.add_argument("--apply", action="store_true", help="Apply and commit the repair")
    args = parser.parse_args(argv)
    report = asyncio.run(run(apply=args.apply))
    print_report(report, apply=args.apply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
