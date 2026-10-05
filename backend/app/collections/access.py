"""One authorization boundary for collection content and sharing.

A link is a read capability only. Membership is bound to a stable user ID;
only Collection.owner_id can administer access, regardless of legacy roles.
All writers lock the collection before checking membership so revocation and
writes serialize. Read capabilities are checked before any content/cache read.
"""

import hashlib
import hmac
import uuid
from typing import Annotated, Literal

from fastapi import Header
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.models import Collection, CollectionMember
from app.common.exceptions import ForbiddenError, NotFoundError

ShareToken = Annotated[str | None, Header(alias="X-Collection-Share-Token", max_length=128)]


def accessible_to(user_id: uuid.UUID):
    return or_(
        Collection.owner_id == user_id,
        Collection.id.in_(
            select(CollectionMember.collection_id).where(CollectionMember.user_id == user_id)
        ),
    )


def editable_by(user_id: uuid.UUID):
    """SQL form of ``authorize(permission="edit")``: the owner or an editor."""
    return or_(
        Collection.owner_id == user_id,
        Collection.id.in_(
            select(CollectionMember.collection_id).where(
                CollectionMember.user_id == user_id, CollectionMember.role == "editor"
            )
        ),
    )


def link_matches(collection: Collection, token: str | None) -> bool:
    return bool(
        token
        and len(token) <= 128
        and collection.read_link_digest
        and hmac.compare_digest(
            collection.read_link_digest, hashlib.sha256(token.encode()).hexdigest()
        )
    )


async def authorize(
    db: AsyncSession,
    collection_id: uuid.UUID,
    user_id: uuid.UUID | None,
    *,
    permission: Literal["read", "edit", "manage"] = "read",
    token: str | None = None,
) -> tuple[Collection, dict]:
    stmt = (
        select(Collection)
        .where(Collection.id == collection_id)
        .execution_options(populate_existing=True)
    )
    if permission != "read":
        stmt = stmt.with_for_update()
    collection = (await db.execute(stmt)).scalar_one_or_none()
    if collection is None:
        raise NotFoundError("Collection not found")
    role = None
    if user_id is not None:
        role = (
            await db.execute(
                select(CollectionMember.role).where(
                    CollectionMember.collection_id == collection_id,
                    CollectionMember.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
    owner = user_id is not None and collection.owner_id == user_id
    edit = owner or role == "editor"
    read = owner or role is not None or link_matches(collection, token)
    if permission == "read" and not read:
        raise NotFoundError("Collection not found or access unavailable")
    if (permission == "edit" and not edit) or (permission == "manage" and not owner):
        raise ForbiddenError("Collection permission required")
    return collection, {"is_owner": owner, "can_edit": edit, "can_manage_access": owner}
