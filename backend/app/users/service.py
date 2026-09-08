"""Personal-data export and privacy-preserving account deletion."""

from __future__ import annotations

from datetime import UTC, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import AccountDeletionTombstone, EmailOutbox
from app.auth.service import lock_user, utcnow
from app.collections.models import Collection, CollectionMember, CollectionPaper
from app.legal import get_legal_config
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.notes.models import Note
from app.papers.models import (
    CachedPaperMetadata,
    UserDismissedPaper,
    UserPaperState,
    UserPaperTag,
    UserPreference,
)
from app.users.models import User
from app.zotero.models import ZoteroCredentials, ZoteroLink


def _columns(row) -> dict:
    return {column.name: getattr(row, column.name) for column in row.__table__.columns}


async def export_user_data(db: AsyncSession, user: User) -> dict:
    owned = (
        (await db.execute(select(Collection).where(Collection.owner_id == user.id))).scalars().all()
    )
    member_rows = (
        (await db.execute(select(CollectionMember).where(CollectionMember.user_id == user.id)))
        .scalars()
        .all()
    )
    owned_ids = list({row.id for row in owned} | {row.collection_id for row in member_rows})
    collection_papers = (
        (
            await db.execute(
                select(CollectionPaper).where(CollectionPaper.collection_id.in_(owned_ids))
            )
        )
        .scalars()
        .all()
        if owned_ids
        else []
    )
    library = (
        (await db.execute(select(UserLibraryEntry).where(UserLibraryEntry.user_id == user.id)))
        .scalars()
        .all()
    )
    versions = (
        (await db.execute(select(UserLibraryVersion).where(UserLibraryVersion.user_id == user.id)))
        .scalars()
        .all()
    )
    notes = (await db.execute(select(Note).where(Note.user_id == user.id))).scalars().all()
    states = (
        (await db.execute(select(UserPaperState).where(UserPaperState.user_id == user.id)))
        .scalars()
        .all()
    )
    tags = (
        (await db.execute(select(UserPaperTag).where(UserPaperTag.user_id == user.id)))
        .scalars()
        .all()
    )
    dismissed = (
        (await db.execute(select(UserDismissedPaper).where(UserDismissedPaper.user_id == user.id)))
        .scalars()
        .all()
    )
    preferences = (
        (await db.execute(select(UserPreference).where(UserPreference.user_id == user.id)))
        .scalars()
        .all()
    )
    links = (
        (await db.execute(select(ZoteroLink).where(ZoteroLink.user_id == user.id))).scalars().all()
    )
    credentials = await db.get(ZoteroCredentials, user.id)
    keys = (
        {row.paper_canonical_key for row in collection_papers + states + tags + dismissed}
        | {row.paper_canonical_key for row in versions}
        | {row.target_key for row in notes if row.target_type == "paper"}
    )
    metadata = (
        (
            await db.execute(
                select(CachedPaperMetadata).where(CachedPaperMetadata.canonical_key.in_(keys))
            )
        )
        .scalars()
        .all()
        if keys
        else []
    )
    return {
        "schema_version": 1,
        "exported_at": utcnow(),
        "account": {
            "id": user.id,
            "email": user.email,
            "display_name": user.display_name,
            "created_at": user.created_at,
            "email_verified_at": user.email_verified_at,
            "terms_version": user.terms_version,
            "privacy_version": user.privacy_version,
        },
        "collections_owned": [_columns(row) for row in owned],
        "collection_memberships": [_columns(row) for row in member_rows],
        "collection_papers": [_columns(row) for row in collection_papers],
        "library": [_columns(row) for row in library],
        "library_versions": [_columns(row) for row in versions],
        "notes": [_columns(row) for row in notes],
        "states": [_columns(row) for row in states],
        "tags": [_columns(row) for row in tags],
        "preferences": [_columns(row) for row in preferences],
        "dismissed_papers": [_columns(row) for row in dismissed],
        "bibliographic_metadata": [_columns(row) for row in metadata],
        "zotero": {
            "connected": credentials is not None,
            "user_id": credentials.zotero_user_id if credentials else None,
            "links": [_columns(row) for row in links],
        },
    }


async def delete_user_account(db: AsyncSession, user: User, *, record_receipt: bool = True) -> None:
    await lock_user(db, user.id)
    if record_receipt:
        from app.common.deletion_journal import record_deletion

        await record_deletion(user.id)
    collections = (
        (
            await db.execute(
                select(Collection).where(Collection.owner_id == user.id).with_for_update()
            )
        )
        .scalars()
        .all()
    )
    for collection in collections:
        members = (
            (
                await db.execute(
                    select(CollectionMember).where(
                        CollectionMember.collection_id == collection.id,
                        CollectionMember.user_id != user.id,
                    )
                )
            )
            .scalars()
            .all()
        )
        if not members:
            await db.delete(collection)
            continue
        members.sort(
            key=lambda member: (
                0 if member.role == "editor" else 1,
                member.joined_at.replace(tzinfo=UTC),
                str(member.user_id),
            )
        )
        successor = members[0]
        collection.owner_id = successor.user_id
        successor.role = "owner"
    retention = get_legal_config().retention.backups_days
    await db.merge(
        AccountDeletionTombstone(user_id=user.id, expires_at=utcnow() + timedelta(days=retention))
    )
    await db.execute(delete(EmailOutbox).where(EmailOutbox.user_id == user.id))
    await db.delete(user)
