"""Zotero one-way sync: credentials, item mapping, idempotency, failures."""

import uuid
from datetime import date

import pytest
import respx
from httpx import Response

from app.auth.service import hash_password
from app.common.exceptions import ConflictError
from app.papers.models import CachedPaperMetadata
from app.papers.service import cache_papers
from app.providers.base import Author, PaperMetadata
from app.users.models import User
from app.zotero import service as zotero_service
from app.zotero.client import ZoteroAuthError, ZoteroClient
from app.zotero.models import ZoteroLink

ZOTERO = "https://api.zotero.org"


async def _make_user(db, email: str) -> User:
    user = User(
        id=uuid.uuid4(),
        email=email,
        password_hash=hash_password("password123"),
        display_name="Test User",
    )
    db.add(user)
    await db.flush()
    return user


def _paper(canonical_key: str, group_key: str, title: str) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        title=title,
        authors=[Author(name="Alice Smith", family_name="Smith", given_name="Alice")],
        abstract="An abstract.",
        publication_date=date(2024, 3, 1),
        doi=canonical_key.removeprefix("doi:") if canonical_key.startswith("doi:") else None,
        venue="Journal of Tests",
        paper_type="journal-article",
        provider_source="openalex",
    )


def _mock_verify(router: respx.MockRouter, user_id: str = "12345"):
    router.get(f"{ZOTERO}/keys/current").mock(
        return_value=Response(200, json={"userID": int(user_id), "access": {}})
    )


@pytest.mark.asyncio
@respx.mock
async def test_set_credentials_verifies_key_and_discovers_user_id(db):
    user = await _make_user(db, "zotero1@example.com")
    _mock_verify(respx.mock, "777")

    status = await zotero_service.set_credentials(db, user.id, "abcd1234efgh")

    assert status.connected is True
    assert status.zotero_user_id == "777"
    assert status.api_key_masked is not None
    assert status.api_key_masked.endswith("efgh")
    assert "abcd" not in status.api_key_masked


@pytest.mark.asyncio
@respx.mock
async def test_invalid_key_raises_auth_error(db):
    respx.get(f"{ZOTERO}/keys/current").mock(return_value=Response(403))
    with pytest.raises(ZoteroAuthError):
        await ZoteroClient("bad-key").verify_key()


@pytest.mark.asyncio
async def test_sync_without_credentials_conflicts(db):
    user = await _make_user(db, "zotero2@example.com")
    with pytest.raises(ConflictError):
        await zotero_service.sync_papers(
            db,
            user.id,
            local_collection_key="whatever",
            collection_name="X",
            canonical_keys=["doi:10.1/a"],
        )


@pytest.mark.asyncio
@respx.mock
async def test_first_sync_creates_collection_items_and_links(db):
    user = await _make_user(db, "zotero3@example.com")
    _mock_verify(respx.mock, "42")
    await zotero_service.set_credentials(db, user.id, "goodkey12345")

    await cache_papers(
        db,
        [
            _paper("doi:10.1/one", "group:one", "Paper One"),
            _paper("doi:10.1/two", "group:two", "Paper Two"),
        ],
    )

    respx.post(f"{ZOTERO}/users/42/collections").mock(
        return_value=Response(200, json={"success": {"0": "COLLKEY1"}, "failed": {}})
    )
    items_route = respx.post(f"{ZOTERO}/users/42/items").mock(
        return_value=Response(
            200,
            json={"success": {"0": "ITEM0001", "1": "ITEM0002"}, "unchanged": {}, "failed": {}},
        )
    )

    report = await zotero_service.sync_papers(
        db,
        user.id,
        local_collection_key="coll-local",
        collection_name="ML Papers",
        canonical_keys=["doi:10.1/one", "doi:10.1/two"],
    )

    assert report.zotero_collection_key == "COLLKEY1"
    assert report.items_created == 2
    assert report.items_updated == 0
    assert report.failures == []
    assert items_route.call_count == 1

    # The pushed payload carries real metadata mapped onto Zotero fields.
    import json

    sent = json.loads(items_route.calls[0].request.content)
    assert sent[0]["title"] == "Paper One"
    assert sent[0]["itemType"] == "journalArticle"
    assert sent[0]["DOI"] == "10.1/one"
    assert sent[0]["publicationTitle"] == "Journal of Tests"
    assert sent[0]["creators"] == [
        {"creatorType": "author", "firstName": "Alice", "lastName": "Smith"}
    ]
    assert sent[0]["collections"] == ["COLLKEY1"]

    # Links persisted for both papers + the collection.
    link = await db.get(ZoteroLink, (user.id, "paper", "doi:10.1/one"))
    assert link is not None and link.zotero_key == "ITEM0001"
    coll_link = await db.get(ZoteroLink, (user.id, "collection", "coll-local"))
    assert coll_link is not None and coll_link.zotero_key == "COLLKEY1"


@pytest.mark.asyncio
@respx.mock
async def test_second_sync_is_idempotent(db):
    user = await _make_user(db, "zotero4@example.com")
    _mock_verify(respx.mock, "42")
    await zotero_service.set_credentials(db, user.id, "goodkey12345")
    await cache_papers(db, [_paper("doi:10.2/re", "group:re", "Resync Paper")])

    respx.post(f"{ZOTERO}/users/42/collections").mock(
        return_value=Response(200, json={"success": {"0": "COLLKEY2"}, "failed": {}})
    )
    respx.post(f"{ZOTERO}/users/42/items").mock(
        return_value=Response(
            200, json={"success": {"0": "ITEMRE01"}, "unchanged": {}, "failed": {}}
        )
    )

    first = await zotero_service.sync_papers(
        db,
        user.id,
        local_collection_key="coll-re",
        collection_name="Resync",
        canonical_keys=["doi:10.2/re"],
    )
    assert first.items_created == 1

    # Second run: the item is linked → membership check says already present.
    respx.get(f"{ZOTERO}/users/42/items/ITEMRE01").mock(
        return_value=Response(
            200,
            json={"key": "ITEMRE01", "version": 3, "data": {"collections": ["COLLKEY2"]}},
        )
    )

    second = await zotero_service.sync_papers(
        db,
        user.id,
        local_collection_key="coll-re",
        collection_name="Resync",
        canonical_keys=["doi:10.2/re"],
    )
    assert second.items_created == 0
    assert second.items_updated == 0
    assert second.items_skipped == 1
    assert second.zotero_collection_key == "COLLKEY2"


@pytest.mark.asyncio
@respx.mock
async def test_linked_item_gains_membership_in_new_collection(db):
    user = await _make_user(db, "zotero5@example.com")
    _mock_verify(respx.mock, "42")
    await zotero_service.set_credentials(db, user.id, "goodkey12345")
    await cache_papers(db, [_paper("doi:10.3/mv", "group:mv", "Moved Paper")])
    db.add(
        ZoteroLink(
            user_id=user.id, local_type="paper", local_key="doi:10.3/mv", zotero_key="ITEMMV01"
        )
    )
    await db.flush()

    respx.post(f"{ZOTERO}/users/42/collections").mock(
        return_value=Response(200, json={"success": {"0": "NEWCOLL1"}, "failed": {}})
    )
    respx.get(f"{ZOTERO}/users/42/items/ITEMMV01").mock(
        return_value=Response(
            200,
            json={"key": "ITEMMV01", "version": 5, "data": {"collections": ["OLDCOLL1"]}},
        )
    )
    patch_route = respx.patch(f"{ZOTERO}/users/42/items/ITEMMV01").mock(return_value=Response(204))

    report = await zotero_service.sync_papers(
        db,
        user.id,
        local_collection_key="another-coll",
        collection_name="Another",
        canonical_keys=["doi:10.3/mv"],
    )

    assert report.items_updated == 1
    assert patch_route.call_count == 1
    import json

    patched = json.loads(patch_route.calls[0].request.content)
    assert patched["collections"] == ["OLDCOLL1", "NEWCOLL1"]
    assert patch_route.calls[0].request.headers["If-Unmodified-Since-Version"] == "5"


@pytest.mark.asyncio
@respx.mock
async def test_failures_are_reported_not_raised(db):
    user = await _make_user(db, "zotero6@example.com")
    _mock_verify(respx.mock, "42")
    await zotero_service.set_credentials(db, user.id, "goodkey12345")
    await cache_papers(db, [_paper("doi:10.4/ok", "group:ok", "Fine Paper")])

    respx.post(f"{ZOTERO}/users/42/collections").mock(
        return_value=Response(200, json={"success": {"0": "COLLKEY3"}, "failed": {}})
    )
    respx.post(f"{ZOTERO}/users/42/items").mock(
        return_value=Response(
            200,
            json={
                "success": {},
                "unchanged": {},
                "failed": {"0": {"code": 400, "message": "Invalid creators"}},
            },
        )
    )

    report = await zotero_service.sync_papers(
        db,
        user.id,
        local_collection_key="coll-fail",
        collection_name="Failures",
        # hash paper has no cached metadata → reported, not raised
        canonical_keys=["doi:10.4/ok", "hash:nometadata"],
    )

    assert report.items_created == 0
    messages = {f.paper_canonical_key: f.message for f in report.failures}
    assert messages["doi:10.4/ok"] == "Rejected by Zotero"
    assert "No cached metadata" in messages["hash:nometadata"]


def test_item_payload_uses_plain_text_title_and_abstract():
    row = CachedPaperMetadata(
        canonical_key="doi:10.9/markup",
        paper_group_key="group:markup",
        title="Odor <i>coding</i>",
        abstract="<h4>Background</h4>Old &amp; raw.",
        paper_type="journal-article",
    )
    item = zotero_service.item_from_cached(row, "COLL1")
    assert item["title"] == "Odor coding"
    assert item["abstractNote"] == "Background: Old & raw."
