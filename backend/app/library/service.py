"""Library service — business logic for the persistent personal archive."""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.models import Collection, CollectionPaper
from app.common.exceptions import ConflictError, NotFoundError
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.notes.models import Note
from app.papers.models import CachedPaperMetadata, UserPaperState, UserPaperTag
from app.papers.service import cached_paper_to_read


async def ensure_entry_and_version(
    db: AsyncSession,
    user_id: uuid.UUID,
    paper_group_key: str,
    canonical_key: str,
    source_provider: str | None = None,
) -> tuple[UserLibraryEntry, UserLibraryVersion]:
    """Idempotently create the library entry + version pin for a paper.

    Called both from explicit POST /library/entries and implicitly from
    collections.add_paper() so adding a paper to any collection always
    leaves a Library trail behind.
    """
    entry_row = await db.execute(
        select(UserLibraryEntry).where(
            UserLibraryEntry.user_id == user_id,
            UserLibraryEntry.paper_group_key == paper_group_key,
        )
    )
    entry = entry_row.scalar_one_or_none()
    if entry is None:
        entry = UserLibraryEntry(
            user_id=user_id,
            paper_group_key=paper_group_key,
            primary_canonical_key=canonical_key,
        )
        db.add(entry)
        await db.flush()

    version_row = await db.execute(
        select(UserLibraryVersion).where(
            UserLibraryVersion.user_id == user_id,
            UserLibraryVersion.paper_canonical_key == canonical_key,
        )
    )
    version = version_row.scalar_one_or_none()
    if version is None:
        version = UserLibraryVersion(
            user_id=user_id,
            paper_canonical_key=canonical_key,
            paper_group_key=paper_group_key,
            source_provider=source_provider,
        )
        db.add(version)
        await db.flush()
    return entry, version


async def list_entries(
    db: AsyncSession, user_id: uuid.UUID, *, page: int = 1, size: int = 25
) -> list[dict]:
    offset = (page - 1) * size

    entries_q = (
        select(UserLibraryEntry)
        .where(UserLibraryEntry.user_id == user_id)
        .order_by(UserLibraryEntry.created_at.desc())
        .offset(offset)
        .limit(size)
    )
    entries = list((await db.execute(entries_q)).scalars().all())
    if not entries:
        return []

    group_keys = [e.paper_group_key for e in entries]
    primary_keys = [e.primary_canonical_key for e in entries]

    cached_q = select(CachedPaperMetadata).where(
        CachedPaperMetadata.canonical_key.in_(primary_keys)
    )
    cached_rows = (await db.execute(cached_q)).scalars().all()
    cached_by_key = {row.canonical_key: row for row in cached_rows}

    counts_q = (
        select(
            UserLibraryVersion.paper_group_key,
            func.count(UserLibraryVersion.paper_canonical_key),
        )
        .where(
            UserLibraryVersion.user_id == user_id,
            UserLibraryVersion.paper_group_key.in_(group_keys),
        )
        .group_by(UserLibraryVersion.paper_group_key)
    )
    counts_by_group = {row[0]: row[1] for row in (await db.execute(counts_q)).all()}

    tags_q = select(UserPaperTag.paper_group_key, UserPaperTag.tag).where(
        UserPaperTag.user_id == user_id,
        UserPaperTag.paper_group_key.in_(group_keys),
    )
    tags_by_group: dict[str, list[str]] = {}
    for row in (await db.execute(tags_q)).all():
        tags_by_group.setdefault(row[0], []).append(row[1])

    items: list[dict] = []
    for entry in entries:
        primary_cached = cached_by_key.get(entry.primary_canonical_key)
        primary_view = (
            cached_paper_to_read(primary_cached).model_dump(mode="json") if primary_cached else None
        )
        items.append(
            {
                "paper_group_key": entry.paper_group_key,
                "primary_canonical_key": entry.primary_canonical_key,
                "created_at": entry.created_at,
                "primary_version": primary_view,
                "version_count": counts_by_group.get(entry.paper_group_key, 0),
                "tags": sorted(tags_by_group.get(entry.paper_group_key, [])),
            }
        )
    return items


async def get_entry(db: AsyncSession, user_id: uuid.UUID, paper_group_key: str) -> dict:
    entry = await db.get(UserLibraryEntry, (user_id, paper_group_key))
    if entry is None:
        raise NotFoundError("Library entry not found")

    pins_q = (
        select(UserLibraryVersion)
        .where(
            UserLibraryVersion.user_id == user_id,
            UserLibraryVersion.paper_group_key == paper_group_key,
        )
        .order_by(UserLibraryVersion.added_at.asc())
    )
    pins = list((await db.execute(pins_q)).scalars().all())

    primary_cached = await db.get(CachedPaperMetadata, entry.primary_canonical_key)
    primary_view = (
        cached_paper_to_read(primary_cached).model_dump(mode="json") if primary_cached else None
    )

    notes_count_q = select(func.count()).where(
        Note.user_id == user_id,
        Note.paper_group_key == paper_group_key,
    )
    notes_count = (await db.execute(notes_count_q)).scalar() or 0

    tags_q = select(UserPaperTag.tag).where(
        UserPaperTag.user_id == user_id,
        UserPaperTag.paper_group_key == paper_group_key,
    )
    tags = sorted({row[0] for row in (await db.execute(tags_q)).all()})

    canonical_keys = [pin.paper_canonical_key for pin in pins]
    states: list[UserPaperState] = []
    if canonical_keys:
        states_q = select(UserPaperState).where(
            UserPaperState.user_id == user_id,
            UserPaperState.paper_canonical_key.in_(canonical_keys),
        )
        states = list((await db.execute(states_q)).scalars().all())

    return {
        "paper_group_key": entry.paper_group_key,
        "primary_canonical_key": entry.primary_canonical_key,
        "created_at": entry.created_at,
        "primary_version": primary_view,
        "pinned_versions": pins,
        "notes_count": notes_count,
        "tags": tags,
        "states": states,
    }


async def repin_primary(
    db: AsyncSession,
    user_id: uuid.UUID,
    paper_group_key: str,
    new_primary: str,
) -> UserLibraryEntry:
    entry = await db.get(UserLibraryEntry, (user_id, paper_group_key))
    if entry is None:
        raise NotFoundError("Library entry not found")

    pin_q = await db.execute(
        select(UserLibraryVersion).where(
            UserLibraryVersion.user_id == user_id,
            UserLibraryVersion.paper_canonical_key == new_primary,
            UserLibraryVersion.paper_group_key == paper_group_key,
        )
    )
    if pin_q.scalar_one_or_none() is None:
        raise ConflictError("Cannot re-pin to a version that is not pinned under this entry")
    entry.primary_canonical_key = new_primary
    db.add(entry)
    await db.flush()
    return entry


async def add_version(
    db: AsyncSession,
    user_id: uuid.UUID,
    paper_group_key: str,
    canonical_key: str,
    source_provider: str | None = None,
) -> UserLibraryVersion:
    entry = await db.get(UserLibraryEntry, (user_id, paper_group_key))
    if entry is None:
        raise NotFoundError("Library entry not found")

    existing = await db.execute(
        select(UserLibraryVersion).where(
            UserLibraryVersion.user_id == user_id,
            UserLibraryVersion.paper_canonical_key == canonical_key,
        )
    )
    pin = existing.scalar_one_or_none()
    if pin is not None:
        # Idempotent — return whatever's already there.
        return pin

    pin = UserLibraryVersion(
        user_id=user_id,
        paper_canonical_key=canonical_key,
        paper_group_key=paper_group_key,
        source_provider=source_provider,
    )
    db.add(pin)
    await db.flush()
    return pin


async def _canonical_keys_in_collections(
    db: AsyncSession, user_id: uuid.UUID, canonical_keys: list[str]
) -> set[str]:
    """Return the subset of keys that are still referenced by at least one
    of this user's collections."""
    if not canonical_keys:
        return set()
    q = (
        select(CollectionPaper.paper_canonical_key)
        .join(Collection, Collection.id == CollectionPaper.collection_id)
        .where(
            Collection.owner_id == user_id,
            CollectionPaper.paper_canonical_key.in_(canonical_keys),
        )
    )
    return {row[0] for row in (await db.execute(q)).all()}


async def remove_version(
    db: AsyncSession,
    user_id: uuid.UUID,
    paper_group_key: str,
    canonical_key: str,
) -> None:
    pin_q = await db.execute(
        select(UserLibraryVersion).where(
            UserLibraryVersion.user_id == user_id,
            UserLibraryVersion.paper_canonical_key == canonical_key,
            UserLibraryVersion.paper_group_key == paper_group_key,
        )
    )
    pin = pin_q.scalar_one_or_none()
    if pin is None:
        raise NotFoundError("Library version not found")

    referenced = await _canonical_keys_in_collections(db, user_id, [canonical_key])
    if canonical_key in referenced:
        raise ConflictError(
            "Cannot remove a version that is still referenced by one or more collections"
        )

    await db.delete(pin)
    await db.flush()


async def delete_entry(db: AsyncSession, user_id: uuid.UUID, paper_group_key: str) -> None:
    entry = await db.get(UserLibraryEntry, (user_id, paper_group_key))
    if entry is None:
        raise NotFoundError("Library entry not found")

    pins_q = await db.execute(
        select(UserLibraryVersion.paper_canonical_key).where(
            UserLibraryVersion.user_id == user_id,
            UserLibraryVersion.paper_group_key == paper_group_key,
        )
    )
    pinned_keys = [row[0] for row in pins_q.all()]
    referenced = await _canonical_keys_in_collections(db, user_id, pinned_keys)
    if referenced:
        raise ConflictError(
            "Cannot delete a library entry while one or more pinned versions "
            "are still referenced by collections. Remove them from the relevant "
            "collections first."
        )

    # Cascade delete: remove notes + tags + states anchored to this group.
    if pinned_keys:
        await db.execute(
            UserPaperState.__table__.delete().where(
                UserPaperState.user_id == user_id,
                UserPaperState.paper_canonical_key.in_(pinned_keys),
            )
        )
    await db.execute(
        UserPaperTag.__table__.delete().where(
            UserPaperTag.user_id == user_id,
            UserPaperTag.paper_group_key == paper_group_key,
        )
    )
    await db.execute(
        Note.__table__.delete().where(
            Note.user_id == user_id,
            Note.paper_group_key == paper_group_key,
        )
    )

    # Pins cascade automatically via FK on entry, but issue an explicit
    # delete so it works under SQLite (which defaults to FK off in tests).
    await db.execute(
        UserLibraryVersion.__table__.delete().where(
            UserLibraryVersion.user_id == user_id,
            UserLibraryVersion.paper_group_key == paper_group_key,
        )
    )
    await db.delete(entry)
    await db.flush()


async def list_group_keys(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
    q = (
        select(UserLibraryEntry.paper_group_key)
        .where(UserLibraryEntry.user_id == user_id)
        .order_by(UserLibraryEntry.created_at.desc())
    )
    return [row[0] for row in (await db.execute(q)).all()]


async def count_entries(db: AsyncSession, user_id: uuid.UUID) -> int:
    q = select(func.count()).where(UserLibraryEntry.user_id == user_id)
    return (await db.execute(q)).scalar() or 0
