"""Collection service — business logic."""

import uuid

from fastapi import HTTPException
from fastapi import status as http_status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.access import accessible_to, authorize
from app.collections.models import Collection, CollectionMember, CollectionPaper
from app.collections.schemas import CollectionCreate, CollectionUpdate
from app.common.exceptions import ForbiddenError, NotFoundError


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


async def add_paper(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, paper_key: str
) -> CollectionPaper:
    await authorize(db, collection_id, user_id, permission="edit")

    existing = await db.execute(
        select(CollectionPaper).where(
            CollectionPaper.collection_id == collection_id,
            CollectionPaper.paper_canonical_key == paper_key,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail="Paper already in collection",
        )

    max_pos = await db.execute(
        select(func.coalesce(func.max(CollectionPaper.position), -1)).where(
            CollectionPaper.collection_id == collection_id
        )
    )
    next_pos = max_pos.scalar_one() + 1

    # Library invariant — every paper in a collection must have a Library
    # entry + version pin behind it, so notes/tags/states can anchor on
    # the group_key. Look up group_key from the cache; fall back to a
    # synthesized hash if the cache row is missing (e.g. legacy import).
    from app.library.service import ensure_entry_and_version
    from app.papers.models import CachedPaperMetadata

    cached = await db.get(CachedPaperMetadata, paper_key)
    if cached is not None:
        paper_group_key = cached.paper_group_key
        source_provider = cached.provider_source
    else:
        # Synthesize a deterministic group_key so the entry can still anchor
        # notes/tags. The opportunistic re-anchor on next provider fetch
        # will overwrite it with the correct value via the backfill script.
        import hashlib

        digest = hashlib.sha256(paper_key.encode("utf-8")).hexdigest()[:16]
        paper_group_key = f"group:{digest}"
        source_provider = None

    await ensure_entry_and_version(db, user_id, paper_group_key, paper_key, source_provider)

    cp = CollectionPaper(
        collection_id=collection_id,
        paper_canonical_key=paper_key,
        added_by=user_id,
        position=next_pos,
    )
    db.add(cp)
    await db.flush()
    return cp


async def remove_paper(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, paper_key: str
) -> None:
    await authorize(db, collection_id, user_id, permission="edit")

    result = await db.execute(
        select(CollectionPaper).where(
            CollectionPaper.collection_id == collection_id,
            CollectionPaper.paper_canonical_key == paper_key,
        )
    )
    cp = result.scalar_one_or_none()
    if cp is None:
        raise NotFoundError("Paper not in collection")
    await db.delete(cp)


async def list_papers(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID | None, token: str | None = None
) -> list[dict]:
    await authorize(db, collection_id, user_id, token=token)

    from app.papers.models import CachedPaperMetadata
    from app.papers.service import cached_paper_to_read

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
    return [
        {
            "paper_canonical_key": cp.paper_canonical_key,
            "paper_group_key": cached.paper_group_key if cached else None,
            "position": cp.position,
            "added_at": cp.added_at,
            # Full metadata snapshot; None when no cached row exists yet —
            # the frontend degrades to showing the canonical key.
            "paper": cached_paper_to_read(cached) if cached else None,
        }
        for cp, cached in rows
    ]


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

    # Distinct papers
    distinct_papers_result = await db.execute(
        select(func.count(func.distinct(CollectionPaper.paper_canonical_key)))
        .join(Collection, Collection.id == CollectionPaper.collection_id)
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
