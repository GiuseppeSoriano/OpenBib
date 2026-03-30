"""Paper service — search, lookup, states, tags."""

import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.papers.models import READING_STATES, UserPaperState, UserPaperTag
from app.common.exceptions import NotFoundError

from fastapi import HTTPException, status


async def set_paper_state(
    db: AsyncSession,
    user_id: uuid.UUID,
    paper_key: str,
    state: str,
    collection_id: uuid.UUID | None = None,
) -> UserPaperState:
    if state not in READING_STATES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid state. Must be one of: {', '.join(READING_STATES)}",
        )

    existing = await db.execute(
        select(UserPaperState).where(
            UserPaperState.user_id == user_id,
            UserPaperState.paper_canonical_key == paper_key,
            UserPaperState.collection_id == collection_id,
        )
    )
    ups = existing.scalar_one_or_none()
    if ups:
        ups.state = state
    else:
        ups = UserPaperState(
            user_id=user_id,
            paper_canonical_key=paper_key,
            state=state,
            collection_id=collection_id,
        )
    db.add(ups)
    await db.flush()
    return ups


async def get_paper_states(
    db: AsyncSession, user_id: uuid.UUID, paper_key: str
) -> list[UserPaperState]:
    result = await db.execute(
        select(UserPaperState).where(
            UserPaperState.user_id == user_id,
            UserPaperState.paper_canonical_key == paper_key,
        )
    )
    return list(result.scalars().all())


async def add_tag(
    db: AsyncSession, user_id: uuid.UUID, paper_key: str, tag: str
) -> UserPaperTag:
    existing = await db.execute(
        select(UserPaperTag).where(
            UserPaperTag.user_id == user_id,
            UserPaperTag.paper_canonical_key == paper_key,
            UserPaperTag.tag == tag,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Tag already exists")

    upt = UserPaperTag(user_id=user_id, paper_canonical_key=paper_key, tag=tag)
    db.add(upt)
    await db.flush()
    return upt


async def remove_tag(
    db: AsyncSession, user_id: uuid.UUID, paper_key: str, tag: str
) -> None:
    result = await db.execute(
        select(UserPaperTag).where(
            UserPaperTag.user_id == user_id,
            UserPaperTag.paper_canonical_key == paper_key,
            UserPaperTag.tag == tag,
        )
    )
    upt = result.scalar_one_or_none()
    if upt is None:
        raise NotFoundError("Tag not found")
    await db.delete(upt)


async def get_tags(
    db: AsyncSession, user_id: uuid.UUID, paper_key: str
) -> list[UserPaperTag]:
    result = await db.execute(
        select(UserPaperTag).where(
            UserPaperTag.user_id == user_id,
            UserPaperTag.paper_canonical_key == paper_key,
        )
    )
    return list(result.scalars().all())
