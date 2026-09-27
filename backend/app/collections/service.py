"""Collection service — business logic."""

import uuid

from fastapi import status as http_status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.models import Collection, CollectionMember, CollectionPaper
from app.collections.schemas import CollectionCreate, CollectionUpdate
from app.common.exceptions import ApiError, ForbiddenError, NotFoundError
from app.common.identifiers import normalize_paper_key, parse_paper_identifier, synthetic_group_key
from app.papers.models import CachedPaperMetadata
from app.papers.service import cache_papers, cached_paper_to_read, get_cached_paper
from app.providers import registry


async def get_collection_or_404(db: AsyncSession, collection_id: uuid.UUID) -> Collection:
    coll = await db.get(Collection, collection_id)
    if coll is None:
        raise NotFoundError("Collection not found")
    return coll


def _can_view(collection: Collection, user_id: uuid.UUID | None, member_roles: dict) -> bool:
    if collection.visibility == "public":
        return True
    if user_id is None:
        return False
    if collection.owner_id == user_id:
        return True
    return user_id in member_roles


def _can_edit(collection: Collection, user_id: uuid.UUID, member_roles: dict) -> bool:
    if collection.owner_id == user_id:
        return True
    return member_roles.get(user_id) in ("owner", "editor")


async def _member_roles(db: AsyncSession, collection_id: uuid.UUID) -> dict[uuid.UUID, str]:
    result = await db.execute(
        select(CollectionMember.user_id, CollectionMember.role).where(
            CollectionMember.collection_id == collection_id
        )
    )
    return {row.user_id: row.role for row in result.all()}


async def list_collections(db: AsyncSession, user_id: uuid.UUID) -> list[dict]:
    stmt = (
        select(
            Collection,
            func.count(CollectionPaper.paper_canonical_key).label("paper_count"),
        )
        .outerjoin(CollectionPaper, CollectionPaper.collection_id == Collection.id)
        .where(Collection.owner_id == user_id)
        .group_by(Collection.id)
        .order_by(Collection.updated_at.desc())
    )
    result = await db.execute(stmt)
    rows = result.all()
    return [
        {
            **row.Collection.__dict__,
            "paper_count": row.paper_count,
            "is_owner": True,
            "can_edit": True,
        }
        for row in rows
    ]


async def create_collection(
    db: AsyncSession, user_id: uuid.UUID, data: CollectionCreate
) -> Collection:
    coll = Collection(
        owner_id=user_id,
        name=data.name,
        description=data.description,
        visibility=data.visibility.value,
    )
    db.add(coll)
    await db.flush()
    # Add owner as member
    db.add(CollectionMember(collection_id=coll.id, user_id=user_id, role="owner"))
    await db.flush()
    return coll


async def get_collection_detail(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID | None
) -> dict:
    coll = await get_collection_or_404(db, collection_id)
    roles = await _member_roles(db, collection_id)
    if not _can_view(coll, user_id, roles):
        raise ForbiddenError()

    paper_count_result = await db.execute(
        select(func.count()).where(CollectionPaper.collection_id == collection_id)
    )
    paper_count = paper_count_result.scalar() or 0

    return {
        **coll.__dict__,
        "paper_count": paper_count,
        "is_owner": coll.owner_id == user_id,
        "can_edit": user_id is not None and _can_edit(coll, user_id, roles),
    }


async def update_collection(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, data: CollectionUpdate
) -> Collection:
    coll = await get_collection_or_404(db, collection_id)
    roles = await _member_roles(db, collection_id)
    if not _can_edit(coll, user_id, roles):
        raise ForbiddenError()

    if data.name is not None:
        coll.name = data.name
    if data.description is not None:
        coll.description = data.description
    if data.visibility is not None:
        coll.visibility = data.visibility.value
    db.add(coll)
    await db.flush()
    return coll


async def delete_collection(db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID) -> None:
    coll = await get_collection_or_404(db, collection_id)
    if coll.owner_id != user_id:
        raise ForbiddenError("Only the owner can delete a collection")
    await db.delete(coll)


async def require_edit(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, *, refresh: bool = False
) -> Collection:
    coll = await db.get(Collection, collection_id, populate_existing=refresh)
    if coll is None:
        raise NotFoundError("Collection not found")
    roles = await _member_roles(db, collection_id)
    if not _can_edit(coll, user_id, roles):
        raise ForbiddenError()
    return coll


async def reopen_for_write(db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """Start the short write transaction that follows provider I/O.

    Callers commit (releasing the per-user row lock that authentication takes
    on every write request) before calling providers; this re-takes the lock
    and re-checks edit rights, which may have changed in the meantime.
    """
    from app.auth.service import lock_user

    await lock_user(db, user_id)
    await require_edit(db, collection_id, user_id, refresh=True)


async def keys_in_collection(
    db: AsyncSession, collection_id: uuid.UUID, canonical_keys: set[str]
) -> set[str]:
    if not canonical_keys:
        return set()
    result = await db.execute(
        select(CollectionPaper.paper_canonical_key).where(
            CollectionPaper.collection_id == collection_id,
            CollectionPaper.paper_canonical_key.in_(canonical_keys),
        )
    )
    return {row[0] for row in result.all()}


def _already_in_collection(canonical_key: str) -> ApiError:
    return ApiError(
        http_status.HTTP_409_CONFLICT,
        "already_in_collection",
        "This paper is already in the collection.",
        canonical_key=canonical_key,
    )


def _paper_row(cp: CollectionPaper, cached: CachedPaperMetadata | None) -> dict:
    return {
        "paper_canonical_key": cp.paper_canonical_key,
        "paper_group_key": cached.paper_group_key if cached else None,
        "position": cp.position,
        "added_at": cp.added_at,
        # Full metadata snapshot; None while the paper is pending (no cached
        # row yet) — the frontend then renders the unresolved card.
        "paper": cached_paper_to_read(cached) if cached else None,
        "resolved": cached is not None,
    }


async def _add_paper_core(
    db: AsyncSession,
    collection_id: uuid.UUID,
    user_id: uuid.UUID,
    canonical_key: str,
    cached: CachedPaperMetadata | None,
) -> dict:
    """Insert the collection row, keeping the Library invariant: every paper
    in a collection has a Library entry + version pin behind it, anchored to
    the provider's real group (a synthetic one while the paper is pending)."""
    from app.library.service import ensure_entry_and_version

    max_pos = await db.execute(
        select(func.coalesce(func.max(CollectionPaper.position), -1)).where(
            CollectionPaper.collection_id == collection_id
        )
    )
    next_pos = (max_pos.scalar() or 0) + 1

    if cached is not None:
        await ensure_entry_and_version(
            db,
            user_id,
            cached.paper_group_key,
            canonical_key,
            cached.provider_source,
            authoritative_group=True,
        )
    else:
        await ensure_entry_and_version(
            db, user_id, synthetic_group_key(canonical_key), canonical_key
        )

    cp = CollectionPaper(
        collection_id=collection_id,
        paper_canonical_key=canonical_key,
        added_by=user_id,
        position=next_pos,
    )
    db.add(cp)
    await db.flush()
    return _paper_row(cp, cached)


async def add_paper(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, raw_key: str
) -> dict:
    """Add a paper by DOI (bare, ``doi:``, ``DOI``-labelled or a doi.org link)
    or by an existing ``hash:`` key, and return it as a list row.

    No provider call happens while the request holds the per-user row lock:
    authorize, parse and pre-dedupe, then commit; resolve the DOI with no
    transaction open; then write in a short transaction that re-checks edit
    rights and duplicates (the provider may answer with an alias key).
    """
    await require_edit(db, collection_id, user_id)
    parsed = parse_paper_identifier(raw_key)
    if await keys_in_collection(db, collection_id, {parsed.canonical_key}):
        raise _already_in_collection(parsed.canonical_key)

    cached = await get_cached_paper(db, parsed.canonical_key)
    if cached is None:
        if parsed.doi is None:
            raise ApiError(
                http_status.HTTP_422_UNPROCESSABLE_CONTENT,
                "unknown_paper_key",
                "This paper key is not known.",
                value=raw_key[:200],
            )
        await db.commit()
        lookup = await registry.resolve_doi(parsed.doi)
        if lookup.status == "not_found":
            raise ApiError(
                http_status.HTTP_422_UNPROCESSABLE_CONTENT,
                "doi_not_found",
                "No paper is registered under this DOI.",
                doi=parsed.doi,
            )
        await reopen_for_write(db, collection_id, user_id)
        if lookup.paper is not None:
            await cache_papers(db, [lookup.paper])
            cached = await get_cached_paper(db, lookup.paper.canonical_key)
        candidates = {parsed.canonical_key} | ({cached.canonical_key} if cached else set())
        present = await keys_in_collection(db, collection_id, candidates)
        if present:
            raise _already_in_collection(min(present))

    canonical_key = cached.canonical_key if cached is not None else parsed.canonical_key
    return await _add_paper_core(db, collection_id, user_id, canonical_key, cached)


async def remove_paper(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, paper_key: str
) -> None:
    await require_edit(db, collection_id, user_id)

    # Exact key first, then the normalized one, so rows stored under a
    # legacy raw key stay removable.
    for key in dict.fromkeys((paper_key, normalize_paper_key(paper_key))):
        result = await db.execute(
            select(CollectionPaper).where(
                CollectionPaper.collection_id == collection_id,
                CollectionPaper.paper_canonical_key == key,
            )
        )
        cp = result.scalar_one_or_none()
        if cp is not None:
            await db.delete(cp)
            return
    raise NotFoundError("Paper not in collection")


async def list_papers(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID | None
) -> list[dict]:
    coll = await get_collection_or_404(db, collection_id)
    roles = await _member_roles(db, collection_id)
    if not _can_view(coll, user_id, roles):
        raise ForbiddenError()

    stmt = (
        select(CollectionPaper, CachedPaperMetadata)
        .outerjoin(
            CachedPaperMetadata,
            CachedPaperMetadata.canonical_key == CollectionPaper.paper_canonical_key,
        )
        .where(CollectionPaper.collection_id == collection_id)
        .order_by(CollectionPaper.position)
    )
    rows = (await db.execute(stmt)).all()
    return [_paper_row(cp, cached) for cp, cached in rows]


async def add_member(
    db: AsyncSession, collection_id: uuid.UUID, owner_id: uuid.UUID, member_id: uuid.UUID, role: str
) -> CollectionMember:
    coll = await get_collection_or_404(db, collection_id)
    if coll.owner_id != owner_id:
        raise ForbiddenError("Only the owner can manage members")

    member = CollectionMember(collection_id=collection_id, user_id=member_id, role=role)
    db.add(member)
    await db.flush()
    return member


async def remove_member(
    db: AsyncSession, collection_id: uuid.UUID, owner_id: uuid.UUID, member_id: uuid.UUID
) -> None:
    coll = await get_collection_or_404(db, collection_id)
    if coll.owner_id != owner_id:
        raise ForbiddenError("Only the owner can manage members")

    result = await db.execute(
        select(CollectionMember).where(
            CollectionMember.collection_id == collection_id,
            CollectionMember.user_id == member_id,
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise NotFoundError("Member not found")
    await db.delete(member)


async def get_paper_memberships(db: AsyncSession, user_id: uuid.UUID) -> dict[str, list[str]]:
    """Return {paper_canonical_key: [collection_id, ...]} for all user's collections."""
    stmt = (
        select(CollectionPaper.paper_canonical_key, CollectionPaper.collection_id)
        .join(Collection, Collection.id == CollectionPaper.collection_id)
        .where(Collection.owner_id == user_id)
    )
    result = await db.execute(stmt)
    memberships: dict[str, list[str]] = {}
    for row in result.all():
        key = row.paper_canonical_key
        cid = str(row.collection_id)
        memberships.setdefault(key, []).append(cid)
    return memberships


async def get_user_stats(db: AsyncSession, user_id: uuid.UUID) -> dict[str, int]:
    """Return collection, paper, and library counts for a user."""
    from app.library.service import count_entries

    # Total collections
    coll_count_result = await db.execute(select(func.count()).where(Collection.owner_id == user_id))
    total_collections = coll_count_result.scalar() or 0

    # Total papers (with duplicates across collections)
    total_papers_result = await db.execute(
        select(func.count(CollectionPaper.paper_canonical_key))
        .join(Collection, Collection.id == CollectionPaper.collection_id)
        .where(Collection.owner_id == user_id)
    )
    total_papers = total_papers_result.scalar() or 0

    # Distinct papers: versions of one work share a group key; uncached keys count on their own
    distinct_papers_result = await db.execute(
        select(
            func.count(
                func.distinct(
                    func.coalesce(
                        CachedPaperMetadata.paper_group_key, CollectionPaper.paper_canonical_key
                    )
                )
            )
        )
        .select_from(CollectionPaper)
        .join(Collection, Collection.id == CollectionPaper.collection_id)
        .outerjoin(
            CachedPaperMetadata,
            CachedPaperMetadata.canonical_key == CollectionPaper.paper_canonical_key,
        )
        .where(Collection.owner_id == user_id)
    )
    distinct_papers = distinct_papers_result.scalar() or 0

    library_total = await count_entries(db, user_id)

    return {
        "total_collections": total_collections,
        "total_papers": total_papers,
        "distinct_papers": distinct_papers,
        "library_total": library_total,
    }
