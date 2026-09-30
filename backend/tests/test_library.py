"""Tests for the Library service — invariants, version pinning, deletion."""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.collections.models import Collection, CollectionPaper
from app.collections.service import add_paper as add_paper_to_collection
from app.collections.service import get_user_stats
from app.common.exceptions import ConflictError, NotFoundError
from app.common.identifiers import synthetic_group_key
from app.library import service as library_service
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.notes.models import Note
from app.papers import service as paper_service
from app.papers.models import CachedPaperMetadata, UserPaperState, UserPaperTag
from app.users.models import User

pytestmark = pytest.mark.asyncio


async def _make_user(db, email="alice@example.com"):
    user = User(
        id=uuid.uuid4(),
        email=email,
        password_hash="x",
        display_name="Alice",
    )
    db.add(user)
    await db.flush()
    return user


async def _make_collection(db, owner_id, name="My Coll"):
    coll = Collection(
        id=uuid.uuid4(),
        owner_id=owner_id,
        name=name,
    )
    db.add(coll)
    await db.flush()
    return coll


async def _cache_paper(db, canonical_key, group_key, *, provider="openalex"):
    row = CachedPaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        title="Some Title",
        authors_json=[{"name": "Alice"}],
        topics_json=[],
        keywords_json=[],
        publication_date=date(2024, 1, 1),
        provider_source=provider,
    )
    db.add(row)
    await db.flush()
    return row


async def test_ensure_entry_and_version_idempotent(db):
    user = await _make_user(db)
    await _cache_paper(db, "doi:10.1/x", "group:x")

    e1, v1 = await library_service.ensure_entry_and_version(
        db, user.id, "group:x", "doi:10.1/x", "openalex"
    )
    e2, v2 = await library_service.ensure_entry_and_version(
        db, user.id, "group:x", "doi:10.1/x", "openalex"
    )

    assert e1.paper_group_key == e2.paper_group_key
    assert v1.paper_canonical_key == v2.paper_canonical_key
    # Sanity — only one of each row
    assert (await db.get(UserLibraryEntry, (user.id, "group:x"))) is not None


async def test_add_paper_to_collection_creates_library_entry(db):
    user = await _make_user(db)
    coll = await _make_collection(db, user.id)
    await _cache_paper(db, "doi:10.1/y", "group:y")

    await add_paper_to_collection(db, coll.id, user.id, "doi:10.1/y")

    entry = await db.get(UserLibraryEntry, (user.id, "group:y"))
    assert entry is not None
    pin = await db.get(UserLibraryVersion, (user.id, "doi:10.1/y"))
    assert pin is not None
    assert pin.paper_group_key == "group:y"


async def test_delete_entry_blocked_when_version_in_collection(db):
    user = await _make_user(db)
    coll = await _make_collection(db, user.id)
    await _cache_paper(db, "doi:10.1/z", "group:z")
    await add_paper_to_collection(db, coll.id, user.id, "doi:10.1/z")

    with pytest.raises(HTTPException) as exc_info:
        await library_service.delete_entry(db, user.id, "group:z")
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "entry_in_collections"
    assert exc_info.value.detail["collections"] == [{"id": str(coll.id), "name": "My Coll"}]


async def test_delete_entry_with_detach_removes_it_from_collections(db):
    user = await _make_user(db)
    coll = await _make_collection(db, user.id)
    await _cache_paper(db, "doi:10.1/z", "group:z")
    await add_paper_to_collection(db, coll.id, user.id, "doi:10.1/z")

    await library_service.delete_entry(db, user.id, "group:z", detach=True)

    assert (await db.get(UserLibraryEntry, (user.id, "group:z"))) is None
    assert (await db.get(CollectionPaper, (coll.id, "doi:10.1/z"))) is None


async def test_unresolved_entry_outside_collections_can_be_deleted(db):
    user = await _make_user(db)
    coll = await _make_collection(db, user.id)
    await add_paper_to_collection(db, coll.id, user.id, "10.9/pending")
    from app.collections.service import remove_paper

    await remove_paper(db, coll.id, user.id, "doi:10.9/pending")
    group = synthetic_group_key("doi:10.9/pending")
    assert (await db.get(UserLibraryEntry, (user.id, group))) is not None

    await library_service.delete_entry(db, user.id, group)

    assert (await db.get(UserLibraryEntry, (user.id, group))) is None
    assert (await db.get(UserLibraryVersion, (user.id, "doi:10.9/pending"))) is None


async def test_real_group_reanchors_a_synthetic_pin_with_its_tags_and_notes(db):
    user = await _make_user(db)
    synthetic = synthetic_group_key("doi:10.1/late")
    await library_service.ensure_entry_and_version(db, user.id, synthetic, "doi:10.1/late")
    await paper_service.add_tag(db, user.id, "doi:10.1/late", "later")
    db.add(
        Note(
            id=uuid.uuid4(),
            user_id=user.id,
            target_type="paper",
            target_key="doi:10.1/late",
            paper_group_key=None,
            content="Read this",
        )
    )
    await db.flush()

    # Metadata arrives later; saving again under the real group must not
    # leave a second, pin-less entry behind.
    await _cache_paper(db, "doi:10.1/late", "group:late")
    entry, pin = await library_service.ensure_entry_and_version(
        db, user.id, "group:late", "doi:10.1/late", "openalex", authoritative_group=True
    )

    assert entry.paper_group_key == "group:late"
    assert pin.paper_group_key == "group:late"
    entries = (
        (await db.execute(select(UserLibraryEntry).where(UserLibraryEntry.user_id == user.id)))
        .scalars()
        .all()
    )
    assert [e.paper_group_key for e in entries] == ["group:late"]
    tags = (await db.execute(select(UserPaperTag).where(UserPaperTag.user_id == user.id))).scalars()
    assert [(t.tag, t.paper_group_key) for t in tags] == [("later", "group:late")]
    notes = (await db.execute(select(Note).where(Note.user_id == user.id))).scalars()
    assert [n.paper_group_key for n in notes] == ["group:late"]


async def test_non_authoritative_group_keeps_the_existing_pin(db):
    user = await _make_user(db)
    await library_service.ensure_entry_and_version(db, user.id, "group:first", "doi:10.1/keep")

    entry, pin = await library_service.ensure_entry_and_version(
        db, user.id, "group:client-guess", "doi:10.1/keep"
    )

    assert entry.paper_group_key == "group:first"
    assert pin.paper_group_key == "group:first"
    assert (await db.get(UserLibraryEntry, (user.id, "group:client-guess"))) is None


async def test_reanchor_moves_only_the_version_when_other_pins_remain(db):
    user = await _make_user(db)
    await library_service.ensure_entry_and_version(db, user.id, "group:mixed", "doi:10.1/a")
    await library_service.ensure_entry_and_version(db, user.id, "group:mixed", "doi:10.1/b")
    await library_service.repin_primary(db, user.id, "group:mixed", "doi:10.1/b")

    await library_service.reanchor_pin(db, user.id, "doi:10.1/b", "group:real")

    old = await db.get(UserLibraryEntry, (user.id, "group:mixed"))
    assert old is not None
    assert old.primary_canonical_key == "doi:10.1/a"
    assert (await db.get(UserLibraryEntry, (user.id, "group:real"))) is not None


async def test_delete_entry_cascades_when_no_collections(db):
    user = await _make_user(db)
    await _cache_paper(db, "doi:10.1/q", "group:q")

    await library_service.ensure_entry_and_version(db, user.id, "group:q", "doi:10.1/q", "openalex")
    db.add(
        UserPaperTag(
            user_id=user.id,
            paper_canonical_key="doi:10.1/q",
            paper_group_key="group:q",
            tag="seminal",
        )
    )
    db.add(
        UserPaperState(
            user_id=user.id,
            paper_canonical_key="doi:10.1/q",
            state="read",
        )
    )
    db.add(
        Note(
            id=uuid.uuid4(),
            user_id=user.id,
            target_type="paper",
            target_key="doi:10.1/q",
            paper_group_key="group:q",
            content="Important",
        )
    )
    await db.flush()

    await library_service.delete_entry(db, user.id, "group:q")

    assert (await db.get(UserLibraryEntry, (user.id, "group:q"))) is None
    # Anchors are gone too.
    from sqlalchemy import select

    tag_rows = (
        await db.execute(
            select(UserPaperTag).where(
                UserPaperTag.user_id == user.id, UserPaperTag.paper_group_key == "group:q"
            )
        )
    ).all()
    assert tag_rows == []
    note_rows = (
        await db.execute(
            select(Note).where(Note.user_id == user.id, Note.paper_group_key == "group:q")
        )
    ).all()
    assert note_rows == []


async def test_remove_version_blocked_when_in_collection(db):
    user = await _make_user(db)
    coll = await _make_collection(db, user.id)
    await _cache_paper(db, "doi:10.1/v1", "group:multi")
    await add_paper_to_collection(db, coll.id, user.id, "doi:10.1/v1")

    with pytest.raises(ConflictError):
        await library_service.remove_version(db, user.id, "group:multi", "doi:10.1/v1")


async def test_pin_extra_version_under_existing_entry(db):
    user = await _make_user(db)
    await _cache_paper(db, "doi:10.1/v1", "group:multi")
    await _cache_paper(db, "doi:10.1/v2", "group:multi", provider="crossref")

    await library_service.ensure_entry_and_version(
        db, user.id, "group:multi", "doi:10.1/v1", "openalex"
    )
    pin = await library_service.add_version(db, user.id, "group:multi", "doi:10.1/v2", "crossref")
    assert pin.paper_canonical_key == "doi:10.1/v2"

    # Idempotent — second add returns the existing pin, no duplicate row.
    pin2 = await library_service.add_version(db, user.id, "group:multi", "doi:10.1/v2", "crossref")
    assert pin2.paper_canonical_key == "doi:10.1/v2"


async def test_repin_primary_requires_existing_pin(db):
    user = await _make_user(db)
    await _cache_paper(db, "doi:10.1/v1", "group:multi")

    await library_service.ensure_entry_and_version(
        db, user.id, "group:multi", "doi:10.1/v1", "openalex"
    )
    with pytest.raises(ConflictError):
        await library_service.repin_primary(db, user.id, "group:multi", "doi:10.1/never-pinned")


async def test_repin_primary_succeeds_for_pinned_version(db):
    user = await _make_user(db)
    await _cache_paper(db, "doi:10.1/v1", "group:multi")
    await _cache_paper(db, "doi:10.1/v2", "group:multi")

    await library_service.ensure_entry_and_version(
        db, user.id, "group:multi", "doi:10.1/v1", "openalex"
    )
    await library_service.add_version(db, user.id, "group:multi", "doi:10.1/v2", "crossref")
    entry = await library_service.repin_primary(db, user.id, "group:multi", "doi:10.1/v2")
    assert entry.primary_canonical_key == "doi:10.1/v2"


async def test_get_entry_404_when_missing(db):
    user = await _make_user(db)
    with pytest.raises(NotFoundError):
        await library_service.get_entry(db, user.id, "group:does-not-exist")


async def test_user_stats_includes_library_total(db):
    user = await _make_user(db, email="bob@example.com")
    coll = await _make_collection(db, user.id, name="Bob's")
    await _cache_paper(db, "doi:10.1/a", "group:a")
    await _cache_paper(db, "doi:10.1/b", "group:b")
    await add_paper_to_collection(db, coll.id, user.id, "doi:10.1/a")
    await add_paper_to_collection(db, coll.id, user.id, "doi:10.1/b")

    stats = await get_user_stats(db, user.id)
    assert stats["library_total"] == 2
    assert stats["distinct_papers"] == 2


async def test_user_stats_count_versions_of_one_paper_once(db):
    user = await _make_user(db, email="carol@example.com")
    first = await _make_collection(db, user.id, name="First")
    second = await _make_collection(db, user.id, name="Second")
    await _cache_paper(db, "doi:10.1/v1", "group:versions")
    await _cache_paper(db, "doi:10.1/v2", "group:versions")
    await add_paper_to_collection(db, first.id, user.id, "doi:10.1/v1")
    await add_paper_to_collection(db, second.id, user.id, "doi:10.1/v2")
    # A legacy row without cached metadata falls back to its own key, once across collections.
    db.add(CollectionPaper(collection_id=first.id, paper_canonical_key="hash:0123456789abcdef"))
    db.add(CollectionPaper(collection_id=second.id, paper_canonical_key="hash:0123456789abcdef"))
    await db.flush()

    stats = await get_user_stats(db, user.id)
    assert stats["total_collections"] == 2
    assert stats["total_papers"] == 4
    assert stats["distinct_papers"] == 2


async def test_remove_paper_from_collection_keeps_library_entry(db):
    """Removing a paper from a collection must NOT touch the Library row."""
    from app.collections.service import remove_paper

    user = await _make_user(db)
    coll = await _make_collection(db, user.id)
    await _cache_paper(db, "doi:10.1/keep", "group:keep")
    await add_paper_to_collection(db, coll.id, user.id, "doi:10.1/keep")
    await remove_paper(db, coll.id, user.id, "doi:10.1/keep")

    entry = await db.get(UserLibraryEntry, (user.id, "group:keep"))
    assert entry is not None
    pin = await db.get(UserLibraryVersion, (user.id, "doi:10.1/keep"))
    assert pin is not None


async def test_tags_are_visible_across_versions_in_same_group(db):
    user = await _make_user(db)
    await _cache_paper(db, "doi:10.1/v1", "group:tagged")
    await _cache_paper(db, "doi:10.1/v2", "group:tagged")

    await paper_service.add_tag(db, user.id, "doi:10.1/v1", "seminal")

    tags = await paper_service.get_tags(db, user.id, "doi:10.1/v2")
    assert [tag.tag for tag in tags] == ["seminal"]
    assert tags[0].paper_group_key == "group:tagged"


async def test_duplicate_tag_is_rejected_across_versions_in_same_group(db):
    user = await _make_user(db)
    await _cache_paper(db, "doi:10.1/v1", "group:tagged")
    await _cache_paper(db, "doi:10.1/v2", "group:tagged")

    await paper_service.add_tag(db, user.id, "doi:10.1/v1", "seminal")

    with pytest.raises(HTTPException) as exc_info:
        await paper_service.add_tag(db, user.id, "doi:10.1/v2", "seminal")
    assert exc_info.value.status_code == 409


async def test_remove_tag_deletes_group_tag_from_all_versions(db):
    user = await _make_user(db)
    await _cache_paper(db, "doi:10.1/v1", "group:tagged")
    await _cache_paper(db, "doi:10.1/v2", "group:tagged")

    await paper_service.add_tag(db, user.id, "doi:10.1/v1", "seminal")
    await paper_service.remove_tag(db, user.id, "doi:10.1/v2", "seminal")

    assert await paper_service.get_tags(db, user.id, "doi:10.1/v1") == []
    assert await paper_service.get_tags(db, user.id, "doi:10.1/v2") == []


async def test_tags_fall_back_to_canonical_key_without_cached_group(db):
    user = await _make_user(db)

    await paper_service.add_tag(db, user.id, "hash:uncached-v1", "uncached")

    assert [tag.tag for tag in await paper_service.get_tags(db, user.id, "hash:uncached-v1")] == [
        "uncached"
    ]
    assert await paper_service.get_tags(db, user.id, "hash:uncached-v2") == []


async def test_library_pagination_is_stable_when_creation_times_match(db):
    from datetime import datetime

    user = await _make_user(db)
    timestamp = datetime(2026, 1, 1)
    for index in reversed(range(102)):
        key = f"group:{index:03}"
        db.add(
            UserLibraryEntry(
                user_id=user.id,
                paper_group_key=key,
                primary_canonical_key=f"s2:{index}",
                created_at=timestamp,
            )
        )
    await db.flush()
    pages = [
        (await library_service.list_entries(db, user.id, page=page, size=25))[0]
        for page in range(1, 6)
    ]
    keys = [entry["paper_group_key"] for page in pages for entry in page]
    assert keys == [f"group:{index:03}" for index in range(102)]
    entries, _ = await library_service.list_entries(db, user.id, page=6, size=25)
    assert entries == []
