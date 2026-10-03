"""Collection service — business logic."""

import uuid

from fastapi import HTTPException
from fastapi import status as http_status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.access import accessible_to, authorize
from app.collections.models import Collection, CollectionMember, CollectionPaper
from app.collections.schemas import CollectionCreate, CollectionUpdate
from app.common.exceptions import ApiError, ForbiddenError, NotFoundError
from app.common.identifiers import (
    ParsedIdentifier,
    normalize_paper_key,
    parse_paper_identifier,
    synthetic_group_key,
)
from app.papers.models import CachedPaperMetadata
from app.papers.service import (
    cached_paper_to_read,
    get_cached_paper,
    get_paper_states_batch,
    get_tags_batch,
    lookup_identifier,
    provider_unavailable,
    store_paper,
)


async def get_collection_or_404(db: AsyncSession, collection_id: uuid.UUID) -> Collection:
    coll = await db.get(Collection, collection_id)
    if coll is None:
        raise NotFoundError("Collection not found")
    return coll


async def list_collections(db: AsyncSession, user_id: uuid.UUID) -> list[dict]:
    stmt = (
        select(
            Collection,
            func.count(CollectionPaper.paper_canonical_key).label("paper_count"),
        )
        .outerjoin(CollectionPaper, CollectionPaper.collection_id == Collection.id)
        .where(accessible_to(user_id))
        .group_by(Collection.id)
        .order_by(Collection.updated_at.desc())
    )
    result = await db.execute(stmt)
    rows = result.all()
    member_roles = dict(
        (
            await db.execute(
                select(CollectionMember.collection_id, CollectionMember.role).where(
                    CollectionMember.user_id == user_id
                )
            )
        ).all()
    )
    return [
        {
            **row.Collection.__dict__,
            "paper_count": row.paper_count,
            "is_owner": row.Collection.owner_id == user_id,
            "can_edit": row.Collection.owner_id == user_id
            or member_roles.get(row.Collection.id) == "editor",
            "can_manage_access": row.Collection.owner_id == user_id,
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
    )
    db.add(coll)
    await db.flush()
    # Add owner as member
    db.add(CollectionMember(collection_id=coll.id, user_id=user_id, role="owner"))
    await db.flush()
    return coll


async def get_collection_detail(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID | None, token: str | None = None
) -> dict:
    coll, permissions = await authorize(db, collection_id, user_id, token=token)

    paper_count_result = await db.execute(
        select(func.count()).where(CollectionPaper.collection_id == collection_id)
    )
    paper_count = paper_count_result.scalar() or 0

    return {
        **coll.__dict__,
        "paper_count": paper_count,
        **permissions,
    }


async def update_collection(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, data: CollectionUpdate
) -> Collection:
    coll, _ = await authorize(db, collection_id, user_id, permission="edit")

    if coll.revision != data.revision:
        raise HTTPException(status_code=409, detail="Collection was modified; reload before saving")
    coll.revision += 1
    coll.updated_at = func.now()
    if data.name is not None:
        coll.name = data.name
    if "description" in data.model_fields_set:
        coll.description = data.description
    db.add(coll)
    await db.flush()
    return coll


async def delete_collection(db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID) -> None:
    coll, _ = await authorize(db, collection_id, user_id, permission="manage")
    await db.delete(coll)


async def require_edit(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID
) -> Collection:
    """Lock the collection row and check edit rights (see ``access.authorize``)."""
    return (await authorize(db, collection_id, user_id, permission="edit"))[0]


async def reopen_for_write(db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """Start the short write transaction that follows provider I/O.

    Callers commit (releasing the per-user row lock that authentication takes
    on every write request, and the collection row lock) before calling
    providers; this re-takes both locks, user row first, and re-checks edit
    rights, which may have changed in the meantime.
    """
    from app.auth.service import lock_user

    await lock_user(db, user_id)
    await authorize(db, collection_id, user_id, permission="edit")


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
    next_pos = max_pos.scalar_one() + 1

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


def _identifier_not_found(parsed: ParsedIdentifier) -> ApiError:
    if parsed.doi is not None:
        return ApiError(
            http_status.HTTP_422_UNPROCESSABLE_CONTENT,
            "doi_not_found",
            "No paper is registered under this DOI.",
            doi=parsed.doi,
        )
    return ApiError(
        http_status.HTTP_422_UNPROCESSABLE_CONTENT,
        "identifier_not_found",
        "Semantic Scholar has no paper with this identifier.",
        value=parsed.canonical_key,
    )


async def add_paper(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, raw_key: str
) -> dict:
    """Add a paper by DOI (bare, ``doi:``, ``DOI``-labelled or a doi.org link),
    Semantic Scholar key or link, arXiv ID or link, ``pmid:``/``pmcid:`` key,
    or by a known ``hash:`` key, and return it as a list row.

    A cached paper (found through any alias) is added under its stored key.
    Otherwise the identifier is resolved first: only a DOI can be stored as
    pending when the provider cannot describe it; any other identifier is
    saved once resolved, or fails (422 ``identifier_not_found``, 503 with
    ``Retry-After``) with nothing written.

    No provider call happens while the request holds the per-user row lock:
    authorize, parse and pre-dedupe, then commit; resolve with no
    transaction open; then write in a short transaction that re-checks edit
    rights and duplicates (the stored row may carry an alias key).
    """
    await require_edit(db, collection_id, user_id)
    parsed = parse_paper_identifier(raw_key)
    if await keys_in_collection(db, collection_id, {parsed.canonical_key}):
        raise _already_in_collection(parsed.canonical_key)

    cached = await get_cached_paper(db, parsed.canonical_key)
    # get_cached_paper resolves aliases: the row may be stored under another key.
    if (
        cached is not None
        and cached.canonical_key != parsed.canonical_key
        and await keys_in_collection(db, collection_id, {cached.canonical_key})
    ):
        raise _already_in_collection(cached.canonical_key)
    if cached is None:
        if parsed.lookup_id is None:
            raise ApiError(
                http_status.HTTP_422_UNPROCESSABLE_CONTENT,
                "unknown_paper_key",
                "This paper key is not known.",
                value=raw_key[:200],
            )
        await db.commit()
        lookup = await lookup_identifier(parsed)
        if lookup.status == "not_found":
            raise _identifier_not_found(parsed)
        if lookup.paper is None and parsed.doi is None:
            raise provider_unavailable(lookup.retry_after, lookup.code)
        await reopen_for_write(db, collection_id, user_id)
        if lookup.paper is not None:
            cached = await store_paper(db, lookup.paper)
        candidates = {parsed.canonical_key} | ({cached.canonical_key} if cached else set())
        present = await keys_in_collection(db, collection_id, candidates)
        if present:
            raise _already_in_collection(min(present))

    canonical_key = cached.canonical_key if cached is not None else parsed.canonical_key
    return await _add_paper_core(db, collection_id, user_id, canonical_key, cached)


async def remove_paper(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, paper_key: str
) -> None:
    await authorize(db, collection_id, user_id, permission="edit")

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
    db: AsyncSession,
    collection_id: uuid.UUID,
    user_id: uuid.UUID | None,
    token: str | None = None,
    *,
    with_annotations: bool = False,
) -> list[dict]:
    await authorize(db, collection_id, user_id, token=token)

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
    items = [_paper_row(cp, cached) for cp, cached in rows]
    if with_annotations and user_id is not None and items:
        # The caller's own annotations, batched: read-link readers see theirs,
        # never the owner's. Only the list endpoint asks (graph and Zotero
        # callers discard them).
        keys = [item["paper_canonical_key"] for item in items]
        states = await get_paper_states_batch(db, user_id, keys)
        tags = await get_tags_batch(db, user_id, keys)
        for item in items:
            item["my_states"] = states[item["paper_canonical_key"]]
            item["my_tags"] = tags[item["paper_canonical_key"]]
    return items


async def list_members(
    db: AsyncSession, collection_id: uuid.UUID, owner_id: uuid.UUID
) -> list[dict]:
    from app.users.models import User

    await authorize(db, collection_id, owner_id, permission="manage")
    rows = (
        await db.execute(
            select(CollectionMember, User)
            .join(User, User.id == CollectionMember.user_id)
            .where(
                CollectionMember.collection_id == collection_id,
                CollectionMember.user_id != owner_id,
            )
            .order_by(User.email)
        )
    ).all()
    return [
        {"user_id": u.id, "email": u.email, "display_name": u.display_name, "role": m.role}
        for m, u in rows
    ]


async def add_member(
    db: AsyncSession, collection_id: uuid.UUID, owner_id: uuid.UUID, email: str
) -> None:
    from app.users.models import User

    await authorize(db, collection_id, owner_id, permission="manage")
    user = (
        await db.execute(
            select(User).where(User.email == email, User.email_verified_at.is_not(None))
        )
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=400, detail="Verified account unavailable")
    if user.id == owner_id:
        return
    member = await db.get(CollectionMember, (collection_id, user.id))
    if member is None:
        db.add(CollectionMember(collection_id=collection_id, user_id=user.id, role="editor"))
    else:
        member.role = "editor"
    await db.flush()


async def remove_member(
    db: AsyncSession, collection_id: uuid.UUID, owner_id: uuid.UUID, member_id: uuid.UUID
) -> None:
    await authorize(db, collection_id, owner_id, permission="manage")
    if member_id == owner_id:
        raise ForbiddenError("Cannot remove the owner")
    member = await db.get(CollectionMember, (collection_id, member_id))
    if member is not None:
        await db.delete(member)


async def get_paper_memberships(db: AsyncSession, user_id: uuid.UUID) -> dict[str, list[str]]:
    """Return {paper_canonical_key: [collection_id, ...]} for all user's collections."""
    stmt = (
        select(CollectionPaper.paper_canonical_key, CollectionPaper.collection_id)
        .join(Collection, Collection.id == CollectionPaper.collection_id)
        .where(accessible_to(user_id))
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
    coll_count_result = await db.execute(select(func.count()).where(accessible_to(user_id)))
    total_collections = coll_count_result.scalar() or 0

    # Total papers (with duplicates across collections)
    total_papers_result = await db.execute(
        select(func.count(CollectionPaper.paper_canonical_key))
        .join(Collection, Collection.id == CollectionPaper.collection_id)
        .where(accessible_to(user_id))
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
        .where(accessible_to(user_id))
    )
    distinct_papers = distinct_papers_result.scalar() or 0

    library_total = await count_entries(db, user_id)

    return {
        "total_collections": total_collections,
        "total_papers": total_papers,
        "distinct_papers": distinct_papers,
        "library_total": library_total,
    }
