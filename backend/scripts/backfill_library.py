"""Idempotent backfill — populate Library + group_key anchors from history.

Run inside the api container:
    docker compose exec api python -m scripts.backfill_library

For every existing (user, collection_id, canonical_key) row in
collection_papers, ensure a Library entry + version pin. Then re-anchor
notes and tags to paper_group_key wherever the cached_paper_metadata row
is now available.

Behavior:
  * Idempotent — safe to re-run; rows already correct are left untouched.
  * Cache-first — looks up paper_group_key from cached_paper_metadata.
    If the row is missing, synthesizes a deterministic group:{sha256(key)[:16]}
    fallback so the entry can still anchor notes/tags. The opportunistic
    re-anchor on next provider fetch will overwrite it.
  * Writes a CSV-like report to stdout summarizing counts.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

# Import every model module so SQLAlchemy can resolve FK relationships
# even when running outside the FastAPI app entrypoint.
from app.auth import models as _auth_models  # noqa: F401
from app.collections import models as _collection_models  # noqa: F401
from app.collections.models import CollectionPaper
from app.common.identifiers import synthetic_group_key
from app.database import async_session_factory
from app.graph import models as _graph_models  # noqa: F401
from app.library import models as _library_models  # noqa: F401
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.library.service import ensure_entry_and_version
from app.notes import models as _note_models  # noqa: F401
from app.notes.models import Note
from app.papers import models as _paper_models  # noqa: F401
from app.papers.models import CachedPaperMetadata, UserPaperTag
from app.users import models as _user_models  # noqa: F401

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_library")


async def _ensure_for_collection_papers(db: AsyncSession) -> tuple[int, int, int]:
    """Walk every (collection_owner, paper) pair and ensure a Library row.

    Returns (rows_visited, entries_inserted, versions_inserted).
    """
    from app.collections.models import Collection

    # Pair every collection_paper with the collection's owner — that is the
    # user whose library should hold the entry.
    q = select(
        Collection.owner_id,
        CollectionPaper.paper_canonical_key,
    ).join(Collection, Collection.id == CollectionPaper.collection_id)
    rows = (await db.execute(q)).all()

    cache_q = select(
        CachedPaperMetadata.canonical_key,
        CachedPaperMetadata.paper_group_key,
        CachedPaperMetadata.provider_source,
    )
    cache_rows = (await db.execute(cache_q)).all()
    cache_by_key = {r[0]: (r[1], r[2]) for r in cache_rows}

    existing_entry_q = select(UserLibraryEntry.user_id, UserLibraryEntry.paper_group_key)
    pre_existing_entries = {(r[0], r[1]) for r in (await db.execute(existing_entry_q)).all()}

    existing_pin_q = select(UserLibraryVersion.user_id, UserLibraryVersion.paper_canonical_key)
    pre_existing_pins = {(r[0], r[1]) for r in (await db.execute(existing_pin_q)).all()}

    inserted_entries = 0
    inserted_pins = 0

    for owner_id, canonical_key in rows:
        cache_hit = cache_by_key.get(canonical_key)
        if cache_hit is not None:
            paper_group_key, provider = cache_hit
        else:
            paper_group_key = synthetic_group_key(canonical_key)
            provider = None

        had_entry_before = (owner_id, paper_group_key) in pre_existing_entries
        had_pin_before = (owner_id, canonical_key) in pre_existing_pins

        await ensure_entry_and_version(db, owner_id, paper_group_key, canonical_key, provider)

        if not had_entry_before:
            inserted_entries += 1
            pre_existing_entries.add((owner_id, paper_group_key))
        if not had_pin_before:
            inserted_pins += 1
            pre_existing_pins.add((owner_id, canonical_key))

    return len(rows), inserted_entries, inserted_pins


async def _anchor_tags(db: AsyncSession) -> int:
    """Backfill paper_group_key on user_paper_tags from cached_paper_metadata."""
    q = (
        update(UserPaperTag)
        .where(
            UserPaperTag.paper_group_key.is_(None),
            UserPaperTag.paper_canonical_key.in_(select(CachedPaperMetadata.canonical_key)),
        )
        .values(
            paper_group_key=(
                select(CachedPaperMetadata.paper_group_key)
                .where(CachedPaperMetadata.canonical_key == UserPaperTag.paper_canonical_key)
                .scalar_subquery()
            )
        )
    )
    result = await db.execute(q)
    return result.rowcount or 0


async def _anchor_notes(db: AsyncSession) -> int:
    q = (
        update(Note)
        .where(
            Note.target_type == "paper",
            Note.paper_group_key.is_(None),
            Note.target_key.in_(select(CachedPaperMetadata.canonical_key)),
        )
        .values(
            paper_group_key=(
                select(CachedPaperMetadata.paper_group_key)
                .where(CachedPaperMetadata.canonical_key == Note.target_key)
                .scalar_subquery()
            )
        )
    )
    result = await db.execute(q)
    return result.rowcount or 0


async def main() -> int:
    async with async_session_factory() as db:
        try:
            visited, entries, pins = await _ensure_for_collection_papers(db)
            log.info(
                "Walked %d collection-paper rows; inserted %d entries, %d version pins",
                visited,
                entries,
                pins,
            )
            tag_anchors = await _anchor_tags(db)
            note_anchors = await _anchor_notes(db)
            log.info(
                "Re-anchored %d tag rows and %d paper notes to paper_group_key",
                tag_anchors,
                note_anchors,
            )
            await db.commit()
        except Exception:
            await db.rollback()
            raise
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
