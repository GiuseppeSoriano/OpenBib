"""Collection service — business logic."""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.models import Collection, CollectionMember, CollectionPaper
from app.collections.schemas import CollectionCreate, CollectionUpdate
from app.common.exceptions import ForbiddenError, NotFoundError


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
        {**row.Collection.__dict__, "paper_count": row.paper_count}
        for row in rows
    ]


async def create_collection(
    db: AsyncSession, user_id: uuid.UUID, data: CollectionCreate
) -> Collection:
    coll = Collection(owner_id=user_id, name=data.name, description=data.description, visibility=data.visibility.value)
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

    return {**coll.__dict__, "paper_count": paper_count}


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


async def delete_collection(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    coll = await get_collection_or_404(db, collection_id)
    if coll.owner_id != user_id:
        raise ForbiddenError("Only the owner can delete a collection")
    await db.delete(coll)


async def add_paper(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, paper_key: str
) -> CollectionPaper:
    coll = await get_collection_or_404(db, collection_id)
    roles = await _member_roles(db, collection_id)
    if not _can_edit(coll, user_id, roles):
        raise ForbiddenError()

    existing = await db.execute(
        select(CollectionPaper).where(
            CollectionPaper.collection_id == collection_id,
            CollectionPaper.paper_canonical_key == paper_key,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise NotFoundError("Paper already in collection")  # idempotent-ish

    max_pos = await db.execute(
        select(func.coalesce(func.max(CollectionPaper.position), -1)).where(
            CollectionPaper.collection_id == collection_id
        )
    )
    next_pos = (max_pos.scalar() or 0) + 1

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
    coll = await get_collection_or_404(db, collection_id)
    roles = await _member_roles(db, collection_id)
    if not _can_edit(coll, user_id, roles):
        raise ForbiddenError()

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
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID | None
) -> list[CollectionPaper]:
    coll = await get_collection_or_404(db, collection_id)
    roles = await _member_roles(db, collection_id)
    if not _can_view(coll, user_id, roles):
        raise ForbiddenError()

    result = await db.execute(
        select(CollectionPaper)
        .where(CollectionPaper.collection_id == collection_id)
        .order_by(CollectionPaper.position)
    )
    return list(result.scalars().all())


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
