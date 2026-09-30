"""Library service — business logic for the persistent personal archive."""

from __future__ import annotations

import uuid

from fastapi import status
from sqlalchemy import and_, case, func, literal, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.access import authorize, editable_by
from app.collections.models import Collection, CollectionPaper
from app.common.exceptions import ApiError, ConflictError, InvalidIdentifierError, NotFoundError
from app.common.identifiers import (
    ParsedIdentifier,
    normalize_paper_key,
    parse_paper_identifier,
    synthetic_group_key,
)
from app.common.key_repair import rekey_user_paper
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.notes.models import Note
from app.papers.models import READING_STATES, CachedPaperMetadata, UserPaperState, UserPaperTag
from app.papers.service import cache_papers, cached_paper_to_read, get_cached_paper
from app.providers import registry


async def _get_pin(
    db: AsyncSession, user_id: uuid.UUID, canonical_key: str
) -> UserLibraryVersion | None:
    result = await db.execute(
        select(UserLibraryVersion).where(
            UserLibraryVersion.user_id == user_id,
            UserLibraryVersion.paper_canonical_key == canonical_key,
        )
    )
    return result.scalar_one_or_none()


async def reanchor_pin(
    db: AsyncSession, user_id: uuid.UUID, canonical_key: str, target_group: str
) -> None:
    """Move the user's pin for ``canonical_key`` under ``target_group``.

    Used when the authoritative group becomes known for a paper that was
    pinned under a synthetic (or stale) group. Tags and notes follow the
    pin; the old entry is deleted once no pins remain under it, so the
    Library never shows a second, pin-less card for the same paper.
    """
    pin = await _get_pin(db, user_id, canonical_key)
    if pin is None or pin.paper_group_key == target_group:
        return
    old_group = pin.paper_group_key

    if await db.get(UserLibraryEntry, (user_id, target_group)) is None:
        db.add(
            UserLibraryEntry(
                user_id=user_id,
                paper_group_key=target_group,
                primary_canonical_key=canonical_key,
            )
        )
        await db.flush()
    pin.paper_group_key = target_group
    await db.flush()

    remaining_q = await db.execute(
        select(UserLibraryVersion.paper_canonical_key)
        .where(
            UserLibraryVersion.user_id == user_id,
            UserLibraryVersion.paper_group_key == old_group,
        )
        .order_by(UserLibraryVersion.added_at.asc())
    )
    remaining = [row[0] for row in remaining_q.all()]
    own_note = and_(Note.target_type == "paper", Note.target_key == canonical_key)
    if remaining:
        # Other versions keep the old entry: only this version's own
        # annotations move with it.
        tag_scope = UserPaperTag.paper_canonical_key == canonical_key
        note_scope = own_note
    else:
        tag_scope = or_(
            UserPaperTag.paper_group_key == old_group,
            UserPaperTag.paper_canonical_key == canonical_key,
        )
        note_scope = or_(Note.paper_group_key == old_group, own_note)

    target_tags_q = await db.execute(
        select(UserPaperTag.tag).where(
            UserPaperTag.user_id == user_id, UserPaperTag.paper_group_key == target_group
        )
    )
    target_tags = {row[0] for row in target_tags_q.all()}
    tags_q = await db.execute(
        select(UserPaperTag).where(UserPaperTag.user_id == user_id, tag_scope)
    )
    for tag in tags_q.scalars().all():
        if tag.paper_group_key == target_group:
            continue
        if tag.tag in target_tags:
            await db.delete(tag)
            continue
        tag.paper_group_key = target_group
        target_tags.add(tag.tag)

    notes_q = await db.execute(select(Note).where(Note.user_id == user_id, note_scope))
    for note in notes_q.scalars().all():
        note.paper_group_key = target_group

    old_entry = await db.get(UserLibraryEntry, (user_id, old_group))
    if old_entry is not None:
        if not remaining:
            await db.delete(old_entry)
        elif old_entry.primary_canonical_key == canonical_key:
            old_entry.primary_canonical_key = remaining[0]
    await db.flush()


async def ensure_entry_and_version(
    db: AsyncSession,
    user_id: uuid.UUID,
    paper_group_key: str,
    canonical_key: str,
    source_provider: str | None = None,
    *,
    authoritative_group: bool = False,
) -> tuple[UserLibraryEntry, UserLibraryVersion]:
    """Idempotently create the library entry + version pin for a paper.

    Called both from explicit POST /library/entries and implicitly from
    collections.add_paper() so adding a paper to any collection always
    leaves a Library trail behind.

    When the paper is already pinned under a different group, the pin is
    re-anchored if ``paper_group_key`` is authoritative (it came from cached
    provider metadata); otherwise the existing entry is returned unchanged.
    """
    version = await _get_pin(db, user_id, canonical_key)
    if version is not None and version.paper_group_key != paper_group_key:
        if authoritative_group:
            await reanchor_pin(db, user_id, canonical_key, paper_group_key)
        else:
            existing = await db.get(UserLibraryEntry, (user_id, version.paper_group_key))
            if existing is not None:
                return existing, version

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


LIBRARY_SORTS = {
    "added": (UserLibraryEntry.created_at.desc(),),
    "title": (func.lower(CachedPaperMetadata.title).asc().nulls_last(),),
    "year": (CachedPaperMetadata.publication_date.desc().nulls_last(),),
    "citations": (CachedPaperMetadata.cited_by_count.desc().nulls_last(),),
}

_PRIMARY_METADATA = CachedPaperMetadata.canonical_key == UserLibraryEntry.primary_canonical_key


def _like_pattern(q: str) -> str:
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _author_name_matches(dialect: str, pattern: str):
    """EXISTS over the decoded author names. ``authors_json`` is plain JSON
    stored with escaped non-ASCII, so matching its text would miss "Müller"
    and match key names such as "name" in every row."""
    authors = CachedPaperMetadata.authors_json
    if dialect == "postgresql":
        elements = case(
            (func.json_typeof(authors) == "array", authors),
            else_=literal_column("'[]'::json"),
        )
        author = func.json_array_elements(elements).table_valued("value").alias("author")
        name = func.json_extract_path_text(author.c.value, "name")
    else:
        author = func.json_each(authors).table_valued("value", "type").alias("author")
        name = case((author.c.type == "object", func.json_extract(author.c.value, "$.name")))
    return select(literal(1)).select_from(author).where(name.ilike(pattern, escape="\\")).exists()


async def _entry_filters(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    q: str | None,
    state: str | None,
    tag: str | None,
    collection_id: uuid.UUID | None,
) -> list:
    filters = [UserLibraryEntry.user_id == user_id]
    if q and q.strip():
        pattern = _like_pattern(q.strip())
        filters.append(
            or_(
                CachedPaperMetadata.title.ilike(pattern, escape="\\"),
                CachedPaperMetadata.venue.ilike(pattern, escape="\\"),
                _author_name_matches(db.get_bind().dialect.name, pattern),
            )
        )
    if state is not None:
        filters.append(
            select(UserPaperState.paper_canonical_key)
            .join(
                UserLibraryVersion,
                and_(
                    UserLibraryVersion.user_id == UserPaperState.user_id,
                    UserLibraryVersion.paper_canonical_key == UserPaperState.paper_canonical_key,
                ),
            )
            .where(
                UserPaperState.user_id == user_id,
                UserPaperState.state == state,
                UserLibraryVersion.paper_group_key == UserLibraryEntry.paper_group_key,
            )
            .exists()
        )
    if tag is not None:
        filters.append(
            select(UserPaperTag.tag)
            .where(
                UserPaperTag.user_id == user_id,
                UserPaperTag.paper_group_key == UserLibraryEntry.paper_group_key,
                UserPaperTag.tag == tag,
            )
            .exists()
        )
    if collection_id is not None:
        # A collection the user cannot read is a 404 (no read-link token here).
        await authorize(db, collection_id, user_id)
        filters.append(
            select(CollectionPaper.paper_canonical_key)
            .join(
                UserLibraryVersion,
                UserLibraryVersion.paper_canonical_key == CollectionPaper.paper_canonical_key,
            )
            .where(
                CollectionPaper.collection_id == collection_id,
                UserLibraryVersion.user_id == user_id,
                UserLibraryVersion.paper_group_key == UserLibraryEntry.paper_group_key,
            )
            .exists()
        )
    return filters


async def list_entries(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    q: str | None = None,
    state: str | None = None,
    tag: str | None = None,
    collection_id: uuid.UUID | None = None,
    sort: str = "added",
    page: int = 1,
    size: int = 25,
) -> tuple[list[dict], int]:
    """One page of the user's Library plus the total matching the filters.
    Raises 404 when ``collection_id`` is not a collection the user can view."""
    filters = await _entry_filters(
        db, user_id, q=q, state=state, tag=tag, collection_id=collection_id
    )
    count_q = (
        select(func.count())
        .select_from(UserLibraryEntry)
        .outerjoin(CachedPaperMetadata, _PRIMARY_METADATA)
        .where(*filters)
    )
    total = (await db.execute(count_q)).scalar() or 0

    entries_q = (
        select(UserLibraryEntry, CachedPaperMetadata)
        .outerjoin(CachedPaperMetadata, _PRIMARY_METADATA)
        .where(*filters)
        .order_by(*LIBRARY_SORTS[sort], UserLibraryEntry.paper_group_key)
        .offset((page - 1) * size)
        .limit(size)
    )
    rows = (await db.execute(entries_q)).all()
    if not rows:
        return [], total

    group_keys = [entry.paper_group_key for entry, _ in rows]

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
    for entry, primary_cached in rows:
        primary_view = (
            cached_paper_to_read(primary_cached).model_dump(mode="json") if primary_cached else None
        )
        items.append(
            {
                "paper_group_key": entry.paper_group_key,
                "primary_canonical_key": entry.primary_canonical_key,
                "created_at": entry.created_at,
                "primary_version": primary_view,
                "resolved": primary_cached is not None,
                "version_count": counts_by_group.get(entry.paper_group_key, 0),
                "tags": sorted(tags_by_group.get(entry.paper_group_key, [])),
            }
        )
    return items, total


async def library_facets(db: AsyncSession, user_id: uuid.UUID) -> dict:
    """Filter options with the number of Library entries behind each."""
    tags_q = (
        select(UserPaperTag.tag, func.count(func.distinct(UserPaperTag.paper_group_key)))
        .join(
            UserLibraryEntry,
            and_(
                UserLibraryEntry.user_id == UserPaperTag.user_id,
                UserLibraryEntry.paper_group_key == UserPaperTag.paper_group_key,
            ),
        )
        .where(UserPaperTag.user_id == user_id)
        .group_by(UserPaperTag.tag)
        .order_by(func.lower(UserPaperTag.tag), UserPaperTag.tag)
    )
    states_q = (
        select(UserPaperState.state, func.count(func.distinct(UserLibraryVersion.paper_group_key)))
        .join(
            UserLibraryVersion,
            and_(
                UserLibraryVersion.user_id == UserPaperState.user_id,
                UserLibraryVersion.paper_canonical_key == UserPaperState.paper_canonical_key,
            ),
        )
        .where(UserPaperState.user_id == user_id)
        .group_by(UserPaperState.state)
    )
    totals_q = (
        select(func.count(), func.count(CachedPaperMetadata.canonical_key))
        .select_from(UserLibraryEntry)
        .outerjoin(CachedPaperMetadata, _PRIMARY_METADATA)
        .where(UserLibraryEntry.user_id == user_id)
    )
    state_counts = {row[0]: row[1] for row in (await db.execute(states_q)).all()}
    total, resolved = (await db.execute(totals_q)).one()
    return {
        "tags": [{"tag": row[0], "count": row[1]} for row in (await db.execute(tags_q)).all()],
        "states": [
            {"state": state, "count": state_counts[state]}
            for state in READING_STATES
            if state in state_counts
        ],
        "total": total,
        "unresolved": total - resolved,
    }


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
    collection this user can edit (a read-only copy never blocks, because
    the user could not detach it)."""
    if not canonical_keys:
        return set()
    q = (
        select(CollectionPaper.paper_canonical_key)
        .join(Collection, Collection.id == CollectionPaper.collection_id)
        .where(
            editable_by(user_id),
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
    # Exact key first, then the normalized one, so legacy pins stay removable.
    pin: UserLibraryVersion | None = None
    for key in dict.fromkeys((canonical_key, normalize_paper_key(canonical_key))):
        pin_q = await db.execute(
            select(UserLibraryVersion).where(
                UserLibraryVersion.user_id == user_id,
                UserLibraryVersion.paper_canonical_key == key,
                UserLibraryVersion.paper_group_key == paper_group_key,
            )
        )
        pin = pin_q.scalar_one_or_none()
        if pin is not None:
            break
    if pin is None:
        raise NotFoundError("Library version not found")

    referenced = await _canonical_keys_in_collections(db, user_id, [pin.paper_canonical_key])
    if pin.paper_canonical_key in referenced:
        raise ConflictError(
            "Cannot remove a version that is still referenced by one or more collections"
        )

    await db.delete(pin)
    await db.flush()


async def delete_entry(
    db: AsyncSession, user_id: uuid.UUID, paper_group_key: str, *, detach: bool = False
) -> None:
    """Delete a Library entry and everything anchored to it.

    While a pinned version is still in a collection the user can edit the
    delete is refused with the list of those collections, unless ``detach``
    asks to remove the paper from them first.
    """
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
    # Same editable-collections scope as _canonical_keys_in_collections.
    blocking = []
    if pinned_keys:
        rows_q = await db.execute(
            select(CollectionPaper, Collection.name)
            .join(Collection, Collection.id == CollectionPaper.collection_id)
            .where(
                editable_by(user_id),
                CollectionPaper.paper_canonical_key.in_(pinned_keys),
            )
            .order_by(Collection.name, Collection.id)
        )
        blocking = list(rows_q.all())
    if blocking and not detach:
        collections = {str(row.CollectionPaper.collection_id): row.name for row in blocking}
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "entry_in_collections",
            "This paper is still in one or more of your collections.",
            collections=[{"id": cid, "name": name} for cid, name in collections.items()],
        )
    for row in blocking:
        await db.delete(row.CollectionPaper)

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


async def _editable_collection_ids(
    db: AsyncSession, user_id: uuid.UUID, canonical_key: str
) -> set[uuid.UUID]:
    """Collections holding ``canonical_key`` that the user may edit (the same
    rule as ``collections.access.authorize(permission="edit")``)."""
    q = (
        select(CollectionPaper.collection_id)
        .join(Collection, Collection.id == CollectionPaper.collection_id)
        .where(CollectionPaper.paper_canonical_key == canonical_key, editable_by(user_id))
    )
    return {row[0] for row in (await db.execute(q)).all()}


def _not_in_library() -> ApiError:
    return ApiError(
        status.HTTP_404_NOT_FOUND,
        "not_in_library",
        "This paper is not in your Library or in a collection you can edit.",
    )


def _stored_target(stored_key: str) -> ParsedIdentifier:
    """What a stored key should become without a replacement: its normalized
    DOI, or a ``hash:`` key (only useful when cached)."""
    try:
        return parse_paper_identifier(normalize_paper_key(stored_key))
    except InvalidIdentifierError:
        raise InvalidIdentifierError(stored_key) from None


async def resolve_library_paper(
    db: AsyncSession, user_id: uuid.UUID, stored_key: str, replacement: str | None
) -> dict:
    """Retry resolution of a stored paper, or correct its identifier.

    Scope is the caller's own pin plus rows in collections they can edit;
    other users' rows are never touched. A found paper is re-keyed to the
    provider's key under its real group; with providers unavailable a legacy
    key still moves to its normalized DOI (pending, synthetic group); a DOI
    that does not exist changes nothing.

    As in ``collections.service.add_paper``, no provider call happens while
    the per-user row lock is held: the scope is checked and committed first,
    the DOI resolves with no transaction open, and the writes happen in a
    short re-locked transaction that re-checks the scope.
    """
    scope_key: str | None = None
    for key in dict.fromkeys((stored_key, normalize_paper_key(stored_key))):
        if await _get_pin(db, user_id, key) or await _editable_collection_ids(db, user_id, key):
            scope_key = key
            break
    if scope_key is None:
        raise _not_in_library()

    parsed = (
        parse_paper_identifier(replacement)
        if replacement is not None
        else _stored_target(scope_key)
    )
    cached = await get_cached_paper(db, parsed.canonical_key)
    status_ = "resolved"
    if cached is None:
        if parsed.doi is None:
            # An unknown hash key: nothing can resolve it.
            if replacement is None:
                raise InvalidIdentifierError(stored_key)
            return await _resolve_result(db, user_id, "not_found", scope_key, scope_key)
        await db.commit()
        lookup = await registry.resolve_doi(parsed.doi)
        if lookup.status == "not_found":
            return await _resolve_result(db, user_id, "not_found", scope_key, scope_key)

        from app.auth.service import lock_user

        await lock_user(db, user_id)
        if lookup.paper is not None:
            stored = (await cache_papers(db, [lookup.paper]))[0]
            cached = await get_cached_paper(db, stored.canonical_key)
        else:
            status_ = "unavailable"

    # Rows and edit rights may have changed while no lock was held.
    pin = await _get_pin(db, user_id, scope_key)
    collection_ids = await _editable_collection_ids(db, user_id, scope_key)
    if pin is None and not collection_ids:
        raise _not_in_library()

    new_key = cached.canonical_key if cached is not None else parsed.canonical_key
    if cached is not None:
        target_group = cached.paper_group_key
    else:
        existing = await _get_pin(db, user_id, new_key)
        target_group = (
            existing.paper_group_key if existing is not None else synthetic_group_key(new_key)
        )

    moved: dict[str, int] = {}
    if new_key != scope_key:
        # The re-key is Core SQL on the session's connection: push pending ORM
        # writes first and drop the now-stale identity map afterwards.
        await db.flush()
        moved = await db.run_sync(
            lambda session: rekey_user_paper(
                session.connection(),
                user_id=user_id,
                old_key=scope_key,
                new_key=new_key,
                target_group=target_group,
                collection_ids=collection_ids,
            )
        )
        db.expire_all()
    if cached is not None:
        await reanchor_pin(db, user_id, new_key, target_group)
    return await _resolve_result(db, user_id, status_, scope_key, new_key, moved)


async def _resolve_result(
    db: AsyncSession,
    user_id: uuid.UUID,
    status_: str,
    previous_key: str,
    canonical_key: str,
    moved: dict[str, int] | None = None,
) -> dict:
    pin = await _get_pin(db, user_id, canonical_key)
    cached = await get_cached_paper(db, canonical_key)
    return {
        "status": status_,
        "previous_key": previous_key,
        "canonical_key": canonical_key,
        "paper_group_key": pin.paper_group_key if pin is not None else None,
        "paper": cached_paper_to_read(cached) if cached is not None else None,
        "moved": moved or {},
    }


async def list_group_keys(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
    q = (
        select(UserLibraryEntry.paper_group_key)
        .where(UserLibraryEntry.user_id == user_id)
        .order_by(UserLibraryEntry.created_at.desc(), UserLibraryEntry.paper_group_key)
    )
    return [row[0] for row in (await db.execute(q)).all()]


async def count_entries(db: AsyncSession, user_id: uuid.UUID) -> int:
    q = select(func.count()).where(UserLibraryEntry.user_id == user_id)
    return (await db.execute(q)).scalar() or 0
