"""Import service — DOI / canonical-key list import.

Export lives in the Zotero one-way sync (app/zotero) — the BibTeX export
was removed in favour of the Zotero-first integration strategy."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.models import CollectionPaper
from app.collections.service import get_collection_or_404, _member_roles, _can_edit
from app.common.exceptions import ForbiddenError


async def import_doi_list(
    db: AsyncSession,
    collection_id: uuid.UUID,
    user_id: uuid.UUID,
    doi_list: list[str],
) -> dict:
    """Import a list of DOIs into a collection. Returns counts of added/skipped."""
    coll = await get_collection_or_404(db, collection_id)
    roles = await _member_roles(db, collection_id)
    if not _can_edit(coll, user_id, roles):
        raise ForbiddenError()

    from app.providers.base import build_canonical_key
    from sqlalchemy import func

    added = 0
    skipped = 0

    for doi in doi_list:
        doi = doi.strip()
        if not doi:
            continue

        canonical_key = build_canonical_key(doi=doi)

        # Check if already in collection
        existing = await db.execute(
            select(CollectionPaper).where(
                CollectionPaper.collection_id == collection_id,
                CollectionPaper.paper_canonical_key == canonical_key,
            )
        )
        if existing.scalar_one_or_none() is not None:
            skipped += 1
            continue

        # Get next position
        max_pos = await db.execute(
            select(func.coalesce(func.max(CollectionPaper.position), -1)).where(
                CollectionPaper.collection_id == collection_id
            )
        )
        next_pos = (max_pos.scalar() or 0) + 1

        cp = CollectionPaper(
            collection_id=collection_id,
            paper_canonical_key=canonical_key,
            added_by=user_id,
            position=next_pos,
        )
        db.add(cp)
        added += 1

    await db.flush()
    return {"added": added, "skipped": skipped, "total": len(doi_list)}


async def import_canonical_keys(
    db: AsyncSession,
    collection_id: uuid.UUID,
    user_id: uuid.UUID,
    keys: list[str],
) -> dict:
    """Import a list of canonical keys into a collection."""
    coll = await get_collection_or_404(db, collection_id)
    roles = await _member_roles(db, collection_id)
    if not _can_edit(coll, user_id, roles):
        raise ForbiddenError()

    from sqlalchemy import func

    added = 0
    skipped = 0

    for key in keys:
        key = key.strip()
        if not key:
            continue

        existing = await db.execute(
            select(CollectionPaper).where(
                CollectionPaper.collection_id == collection_id,
                CollectionPaper.paper_canonical_key == key,
            )
        )
        if existing.scalar_one_or_none() is not None:
            skipped += 1
            continue

        max_pos = await db.execute(
            select(func.coalesce(func.max(CollectionPaper.position), -1)).where(
                CollectionPaper.collection_id == collection_id
            )
        )
        next_pos = (max_pos.scalar() or 0) + 1

        cp = CollectionPaper(
            collection_id=collection_id,
            paper_canonical_key=key,
            added_by=user_id,
            position=next_pos,
        )
        db.add(cp)
        added += 1

    await db.flush()
    return {"added": added, "skipped": skipped, "total": len(keys)}
