"""Zotero one-way sync service: push collections/library papers to Zotero.

Idempotency comes from the zotero_links table — every synced object keeps
its Zotero key, so re-running a sync updates memberships instead of
duplicating items."""

from __future__ import annotations

import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.crypto import EncryptedValue, keyring
from app.common.exceptions import ConflictError, NotFoundError
from app.common.text import clean_inline_text, normalize_abstract
from app.papers.models import CachedPaperMetadata
from app.papers.service import get_cached_papers_by_keys
from app.zotero.client import MAX_BATCH, ZoteroClient, ZoteroError
from app.zotero.models import ZoteroCredentials, ZoteroLink
from app.zotero.schemas import ZoteroCredentialsStatus, ZoteroSyncFailure, ZoteroSyncReport

LIBRARY_SENTINEL = "library"

# OpenBib paper_type → Zotero itemType
_ITEM_TYPES = {
    "preprint": "preprint",
    "posted-content": "preprint",
    "conference-paper": "conferencePaper",
    "proceedings-article": "conferencePaper",
    "book-chapter": "bookSection",
    "book": "book",
    "report": "report",
    "dissertation": "thesis",
}


def _mask_key(api_key: str) -> str:
    if len(api_key) <= 4:
        return "****"
    return f"{'*' * (len(api_key) - 4)}{api_key[-4:]}"


# ── Credentials ──────────────────────────────────────────────


async def get_credentials(db: AsyncSession, user_id: uuid.UUID) -> ZoteroCredentials | None:
    return await db.get(ZoteroCredentials, user_id)


async def credentials_status(db: AsyncSession, user_id: uuid.UUID) -> ZoteroCredentialsStatus:
    creds = await get_credentials(db, user_id)
    if creds is None:
        return ZoteroCredentialsStatus(connected=False)
    return ZoteroCredentialsStatus(
        connected=True,
        zotero_user_id=creds.zotero_user_id,
        api_key_masked=f"****{creds.api_key_last_four}",
    )


def _decrypt_key(creds: ZoteroCredentials) -> str:
    return keyring.decrypt(
        EncryptedValue(creds.api_key_ciphertext, creds.api_key_nonce, creds.api_key_version),
        purpose="zotero",
        aad=f"zotero:{creds.user_id}",
    )


async def set_credentials(
    db: AsyncSession, user_id: uuid.UUID, api_key: str
) -> ZoteroCredentialsStatus:
    """Verify the key against Zotero, auto-discover the Zotero userID,
    and upsert the credentials."""
    info = await ZoteroClient(api_key).verify_key()
    zotero_user_id = str(info.get("userID") or "")
    if not zotero_user_id:
        raise ZoteroError("Zotero key verification returned no userID")

    encrypted = keyring.encrypt(api_key, purpose="zotero", aad=f"zotero:{user_id}")
    creds = await get_credentials(db, user_id)
    if creds is None:
        creds = ZoteroCredentials(
            user_id=user_id,
            api_key_ciphertext=encrypted.ciphertext,
            api_key_nonce=encrypted.nonce,
            api_key_version=encrypted.key_version,
            api_key_last_four=api_key[-4:],
            zotero_user_id=zotero_user_id,
        )
        db.add(creds)
    else:
        creds.api_key_ciphertext = encrypted.ciphertext
        creds.api_key_nonce = encrypted.nonce
        creds.api_key_version = encrypted.key_version
        creds.api_key_last_four = api_key[-4:]
        creds.zotero_user_id = zotero_user_id
    await db.flush()
    return ZoteroCredentialsStatus(
        connected=True,
        zotero_user_id=zotero_user_id,
        api_key_masked=_mask_key(api_key),
    )


async def delete_credentials(db: AsyncSession, user_id: uuid.UUID) -> None:
    await db.execute(delete(ZoteroCredentials).where(ZoteroCredentials.user_id == user_id))
    await db.execute(delete(ZoteroLink).where(ZoteroLink.user_id == user_id))


# ── Item mapping ─────────────────────────────────────────────


def _creators(authors_json: list | None) -> list[dict]:
    creators = []
    for author in authors_json or []:
        family = author.get("family_name")
        given = author.get("given_name")
        if family or given:
            creators.append(
                {"creatorType": "author", "firstName": given or "", "lastName": family or ""}
            )
        elif author.get("name"):
            creators.append({"creatorType": "author", "name": author["name"]})
    return creators


def item_from_cached(row: CachedPaperMetadata, collection_key: str) -> dict:
    """Map an OpenBib cached-metadata row onto a Zotero item payload."""
    item_type = _ITEM_TYPES.get((row.paper_type or "").lower(), "journalArticle")
    extra_parts = []
    if row.arxiv_id:
        extra_parts.append(f"arXiv: {row.arxiv_id}")
    if row.pmid:
        extra_parts.append(f"PMID: {row.pmid}")
    extra_parts.append(f"OpenBib: {row.canonical_key}")

    item: dict = {
        "itemType": item_type,
        "title": clean_inline_text(row.title),
        "creators": _creators(row.authors_json),
        "abstractNote": normalize_abstract(row.abstract) or "",
        "date": row.publication_date.isoformat() if row.publication_date else "",
        "url": row.abstract_url or (f"https://doi.org/{row.doi}" if row.doi else ""),
        "extra": "\n".join(extra_parts),
        "collections": [collection_key],
    }
    # DOI / publication fields only exist on some item types.
    if item_type in ("journalArticle", "conferencePaper", "preprint"):
        item["DOI"] = row.doi or ""
    if item_type == "journalArticle":
        item["publicationTitle"] = row.venue or ""
        item["volume"] = row.volume or ""
        item["issue"] = row.issue or ""
        item["pages"] = row.pages or ""
    elif item_type == "conferencePaper":
        item["proceedingsTitle"] = row.venue or ""
        item["pages"] = row.pages or ""
    return item


# ── Sync ─────────────────────────────────────────────────────


async def _get_link(
    db: AsyncSession, user_id: uuid.UUID, local_type: str, local_key: str
) -> ZoteroLink | None:
    return await db.get(ZoteroLink, (user_id, local_type, local_key))


async def _ensure_zotero_collection(
    db: AsyncSession,
    client: ZoteroClient,
    creds: ZoteroCredentials,
    local_key: str,
    name: str,
) -> str:
    link = await _get_link(db, creds.user_id, "collection", local_key)
    if link is not None:
        return link.zotero_key
    zotero_key = await client.create_collection(creds.zotero_user_id, name)
    db.add(
        ZoteroLink(
            user_id=creds.user_id,
            local_type="collection",
            local_key=local_key,
            zotero_key=zotero_key,
        )
    )
    await db.flush()
    return zotero_key


async def sync_papers(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    local_collection_key: str,
    collection_name: str,
    canonical_keys: list[str],
) -> ZoteroSyncReport:
    """Push the given papers into a Zotero collection (created on first sync).

    Unlinked papers are batch-created (<=50 per request); already-linked
    papers get the collection membership added. Individual failures are
    reported, never raised."""
    creds = await get_credentials(db, user_id)
    if creds is None:
        raise ConflictError("Zotero is not configured. Add your API key in Settings first.")

    client = ZoteroClient(_decrypt_key(creds))
    report = ZoteroSyncReport(zotero_collection_key="")
    report.zotero_collection_key = await _ensure_zotero_collection(
        db, client, creds, local_collection_key, collection_name
    )

    rows = await get_cached_papers_by_keys(db, set(canonical_keys))

    to_create: list[tuple[str, dict]] = []  # (canonical_key, item payload)
    for key in dict.fromkeys(canonical_keys):
        link = await _get_link(db, user_id, "paper", key)
        if link is not None:
            try:
                outcome = await client.add_item_to_collection(
                    creds.zotero_user_id, link.zotero_key, report.zotero_collection_key
                )
            except ZoteroError:
                report.failures.append(
                    ZoteroSyncFailure(paper_canonical_key=key, message="Zotero request failed")
                )
                continue
            if outcome == "updated":
                report.items_updated += 1
            else:
                report.items_skipped += 1
            continue

        row = rows.get(key)
        if row is None:
            report.failures.append(
                ZoteroSyncFailure(
                    paper_canonical_key=key,
                    message="No cached metadata for this paper yet",
                )
            )
            continue
        to_create.append((key, item_from_cached(row, report.zotero_collection_key)))

    for start in range(0, len(to_create), MAX_BATCH):
        batch = to_create[start : start + MAX_BATCH]
        try:
            result = await client.create_items(creds.zotero_user_id, [item for _, item in batch])
        except ZoteroError as exc:
            for key, _ in batch:
                report.failures.append(ZoteroSyncFailure(paper_canonical_key=key, message=str(exc)))
            continue

        success: dict = result.get("success", {})
        for index, (key, _) in enumerate(batch):
            idx = str(index)
            if idx in success:
                db.add(
                    ZoteroLink(
                        user_id=user_id,
                        local_type="paper",
                        local_key=key,
                        zotero_key=success[idx],
                    )
                )
                report.items_created += 1
            else:
                message = "Rejected by Zotero"
                report.failures.append(ZoteroSyncFailure(paper_canonical_key=key, message=message))
        await db.flush()

    return report


async def sync_collection(
    db: AsyncSession, user_id: uuid.UUID, collection_id: uuid.UUID, share_token: str | None = None
) -> ZoteroSyncReport:
    from app.collections import service as collections_service

    coll = await collections_service.get_collection_or_404(db, collection_id)
    rows = await collections_service.list_papers(db, collection_id, user_id, share_token)
    return await sync_papers(
        db,
        user_id,
        local_collection_key=str(collection_id),
        collection_name=coll.name,
        canonical_keys=[row["paper_canonical_key"] for row in rows],
    )


async def sync_library(db: AsyncSession, user_id: uuid.UUID) -> ZoteroSyncReport:
    from app.library.models import UserLibraryEntry

    result = await db.execute(
        select(UserLibraryEntry.primary_canonical_key).where(UserLibraryEntry.user_id == user_id)
    )
    keys = [row[0] for row in result.all()]
    if not keys:
        raise NotFoundError("Your library is empty — nothing to sync")
    return await sync_papers(
        db,
        user_id,
        local_collection_key=LIBRARY_SENTINEL,
        collection_name="OpenBib Library",
        canonical_keys=keys,
    )
