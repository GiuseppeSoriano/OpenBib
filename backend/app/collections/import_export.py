"""Collection imports use the same authorization and library path as single additions."""

import uuid

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.access import authorize
from app.collections.service import add_paper
from app.providers.base import build_canonical_key


async def import_canonical_keys(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, keys: list[str]
) -> dict:
    await authorize(db, collection_id, user_id, permission="edit")
    added = skipped = 0
    for key in keys:
        key = key.strip()
        if not key:
            continue
        try:
            await add_paper(db, collection_id, user_id, key)
            added += 1
        except HTTPException as exc:
            if exc.status_code != 409:
                raise
            skipped += 1
    return {"added": added, "skipped": skipped, "total": len(keys)}


async def import_doi_list(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, doi_list: list[str]
) -> dict:
    result = await import_canonical_keys(
        db,
        collection_id,
        user_id,
        [build_canonical_key(doi=d.strip()) for d in doi_list if d.strip()],
    )
    return {**result, "total": len(doi_list)}
