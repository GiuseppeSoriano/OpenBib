"""Legacy paper-key repair (migration 1d2e3f4a5b6c): SQLite by default,
PostgreSQL in CI and with TEST_DB_URL."""

from __future__ import annotations

import uuid
from datetime import date, datetime

import pytest
from sqlalchemy import select

from app.collections.models import Collection, CollectionMember, CollectionPaper
from app.common import key_repair
from app.common.identifiers import normalize_paper_key, synthetic_group_key
from app.graph.models import PaperGraphEdge
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.notes.models import Note
from app.papers.models import (
    CachedPaperMetadata,
    UserDismissedPaper,
    UserPaperState,
    UserPaperTag,
)
from app.users.models import User
from app.zotero.models import ZoteroLink
from tests.test_identifiers import INVALID, VALID

TNN = "doi:10.1109/tnn.2008.2005605"
RAW = "10.1109/tnn.2008.2005605"
DX = "https://dx.doi.org/10.1109/TNN.2008.2005605"
DOUBLE = "doi:DOI:10.1000/XYZ123"
INVALID_KEY = "doi:not-a-doi"
T0 = datetime(2026, 1, 1, 9, 0, 0)


async def _repair(db, **kwargs):
    report = await db.run_sync(
        lambda session: key_repair.repair_paper_keys(session.connection(), **kwargs)
    )
    db.expire_all()
    return report


async def _user(db, email="repair@example.com") -> uuid.UUID:
    user = User(id=uuid.uuid4(), email=email, password_hash="x", display_name="Repair")
    db.add(user)
    await db.flush()
    return user.id


async def _collection(db, owner_id, name="Audit", members=()) -> uuid.UUID:
    coll = Collection(id=uuid.uuid4(), owner_id=owner_id, name=name)
    db.add(coll)
    await db.flush()
    db.add(CollectionMember(collection_id=coll.id, user_id=owner_id, role="owner"))
    for member_id, role in members:
        db.add(CollectionMember(collection_id=coll.id, user_id=member_id, role=role))
    await db.flush()
    return coll.id


def _cached(key, group):
    return CachedPaperMetadata(
        canonical_key=key,
        paper_group_key=group,
        title="The Graph Neural Network Model",
        authors_json=[{"name": "Franco Scarselli"}],
        topics_json=[],
        keywords_json=[],
        publication_date=date(2009, 1, 1),
        provider_source="openalex",
    )


async def _pinned(db, user_id, key, group, *, at=T0):
    if await db.get(UserLibraryEntry, (user_id, group)) is None:
        db.add(
            UserLibraryEntry(
                user_id=user_id, paper_group_key=group, primary_canonical_key=key, created_at=at
            )
        )
        await db.flush()
    db.add(
        UserLibraryVersion(
            user_id=user_id, paper_canonical_key=key, paper_group_key=group, added_at=at
        )
    )
    await db.flush()


async def _rows(db, *columns, **filters):
    stmt = select(*columns)
    table = columns[0].class_
    for name, value in filters.items():
        stmt = stmt.where(getattr(table, name) == value)
    return sorted(tuple(row) for row in (await db.execute(stmt)).all())


async def _seed_audit_shape(db):
    """The audit collection: raw and ``doi:`` rows for one paper, a doi.org
    link, a doubled label and an invalid key, with annotations on the raw key."""
    user_id = await _user(db)
    coll_id = await _collection(db, user_id)
    db.add(_cached(TNN, "group:gnn"))
    for position, key in enumerate((RAW, TNN, DX, DOUBLE, INVALID_KEY)):
        db.add(
            CollectionPaper(
                collection_id=coll_id,
                paper_canonical_key=key,
                added_by=user_id,
                position=position,
                added_at=T0.replace(hour=9 + position),
            )
        )
        group = "group:gnn" if key == TNN else synthetic_group_key(key)
        await _pinned(db, user_id, key, group, at=T0.replace(hour=9 + position))
    db.add_all(
        [
            UserPaperState(user_id=user_id, paper_canonical_key=RAW, state="reading"),
            UserPaperState(user_id=user_id, paper_canonical_key=TNN, state="to_read"),
            UserPaperState(user_id=user_id, paper_canonical_key=DX, state="seen"),
            UserPaperTag(
                user_id=user_id,
                paper_canonical_key=RAW,
                tag="gnn",
                paper_group_key=synthetic_group_key(RAW),
            ),
            UserPaperTag(
                user_id=user_id,
                paper_canonical_key=RAW,
                tag="survey",
                paper_group_key=synthetic_group_key(RAW),
            ),
            UserPaperTag(
                user_id=user_id, paper_canonical_key=TNN, tag="gnn", paper_group_key="group:gnn"
            ),
            Note(
                user_id=user_id,
                target_type="paper",
                target_key=RAW,
                paper_group_key=synthetic_group_key(RAW),
                content="On the raw key",
            ),
        ]
    )
    await db.flush()
    return user_id, coll_id


async def test_audit_shape_merges_into_one_record(db):
    user_id, coll_id = await _seed_audit_shape(db)

    report = await _repair(db)

    assert report.mapped == 3
    assert report.unrepairable == [INVALID_KEY]
    assert report.counts["collection_papers"] == 3
    assert report.counts["collection_papers_merged"] == 2
    rows = await _rows(
        db,
        CollectionPaper.paper_canonical_key,
        CollectionPaper.position,
        CollectionPaper.added_at,
        collection_id=coll_id,
    )
    assert rows == sorted(
        [
            ("doi:10.1000/xyz123", 3, T0.replace(hour=12)),
            (INVALID_KEY, 4, T0.replace(hour=13)),
            (TNN, 0, T0),
        ]
    )
    xyz_group = synthetic_group_key("doi:10.1000/xyz123")
    assert await _rows(
        db,
        UserLibraryEntry.paper_group_key,
        UserLibraryEntry.primary_canonical_key,
        UserLibraryEntry.created_at,
        user_id=user_id,
    ) == sorted(
        [
            ("group:gnn", TNN, T0.replace(hour=10)),
            (xyz_group, "doi:10.1000/xyz123", T0.replace(hour=12)),
            (synthetic_group_key(INVALID_KEY), INVALID_KEY, T0.replace(hour=13)),
        ]
    )
    assert await _rows(
        db,
        UserLibraryVersion.paper_canonical_key,
        UserLibraryVersion.paper_group_key,
        UserLibraryVersion.added_at,
        user_id=user_id,
    ) == sorted(
        [
            ("doi:10.1000/xyz123", xyz_group, T0.replace(hour=12)),
            (INVALID_KEY, synthetic_group_key(INVALID_KEY), T0.replace(hour=13)),
            (TNN, "group:gnn", T0),
        ]
    )
    assert await _rows(
        db, UserPaperState.paper_canonical_key, UserPaperState.state, user_id=user_id
    ) == [(TNN, "reading")]
    assert await _rows(
        db,
        UserPaperTag.paper_canonical_key,
        UserPaperTag.tag,
        UserPaperTag.paper_group_key,
        user_id=user_id,
    ) == [(TNN, "gnn", "group:gnn"), (TNN, "survey", "group:gnn")]
    assert await _rows(db, Note.target_key, Note.paper_group_key, user_id=user_id) == [
        (TNN, "group:gnn")
    ]
    # Cached snapshots are never touched.
    assert await _rows(db, CachedPaperMetadata.canonical_key) == [(TNN,)]


async def test_second_run_maps_nothing(db):
    await _seed_audit_shape(db)
    await _repair(db)
    snapshot = await _rows(
        db, CollectionPaper.paper_canonical_key, CollectionPaper.position
    ) + await _rows(db, UserLibraryVersion.paper_canonical_key, UserLibraryVersion.paper_group_key)

    again = await _repair(db)

    assert again.mapped == 0
    assert again.counts == {}
    assert again.unrepairable == [INVALID_KEY]
    assert (
        await _rows(db, CollectionPaper.paper_canonical_key, CollectionPaper.position)
        + await _rows(
            db, UserLibraryVersion.paper_canonical_key, UserLibraryVersion.paper_group_key
        )
        == snapshot
    )


async def test_dry_run_reports_counts_and_writes_nothing(db):
    await _seed_audit_shape(db)
    tables = [
        (CollectionPaper.paper_canonical_key, CollectionPaper.position),
        (UserLibraryEntry.paper_group_key, UserLibraryEntry.primary_canonical_key),
        (UserLibraryVersion.paper_canonical_key, UserLibraryVersion.paper_group_key),
        (UserPaperState.paper_canonical_key, UserPaperState.state),
        (UserPaperTag.paper_canonical_key, UserPaperTag.tag, UserPaperTag.paper_group_key),
        (Note.target_key, Note.paper_group_key),
    ]
    before = [await _rows(db, *columns) for columns in tables]

    preview = await _repair(db, dry_run=True)

    assert preview.mapped == 3
    assert preview.counts["collection_papers_merged"] == 2
    assert preview.unrepairable == [INVALID_KEY]
    assert [await _rows(db, *columns) for columns in tables] == before
    applied = await _repair(db)
    assert applied.counts == preview.counts


async def test_every_key_bearing_table_is_rekeyed(db):
    alice = await _user(db, "alice@example.com")
    bob = await _user(db, "bob@example.com")
    first = await _collection(db, alice, "First")
    second = await _collection(db, alice, "Second")
    bare = "10.1/ABC"
    key = "doi:10.1/abc"
    db.add_all(
        [
            CollectionPaper(collection_id=first, paper_canonical_key=bare, position=0),
            CollectionPaper(collection_id=second, paper_canonical_key=bare, position=4),
            CollectionPaper(collection_id=second, paper_canonical_key=key, position=2),
        ]
    )
    await _pinned(db, alice, bare, synthetic_group_key(bare))
    await _pinned(db, bob, "https://doi.org/10.1/abc", "group:client")
    db.add_all(
        [
            UserDismissedPaper(user_id=alice, paper_canonical_key=bare),
            UserDismissedPaper(user_id=alice, paper_canonical_key=key),
            UserDismissedPaper(user_id=bob, paper_canonical_key="DOI 10.1/ABC"),
            ZoteroLink(user_id=alice, local_type="paper", local_key=bare, zotero_key="RAWLINK1"),
            ZoteroLink(user_id=alice, local_type="paper", local_key=key, zotero_key="CANON001"),
            ZoteroLink(
                user_id=bob, local_type="paper", local_key="doi:DOI:10.1/abc", zotero_key="BOB00001"
            ),
            ZoteroLink(
                user_id=alice, local_type="collection", local_key="10.1/ABC", zotero_key="COLL0001"
            ),
            PaperGraphEdge(
                source_key=bare, target_key="doi:10.2/x", relation_type="cites", provider_source="o"
            ),
            PaperGraphEdge(
                source_key=key, target_key="doi:10.2/x", relation_type="cites", provider_source="o"
            ),
            PaperGraphEdge(
                source_key="doi:10.2/x",
                target_key="DOI:10.1/abc",
                relation_type="cites",
                provider_source="o",
            ),
            PaperGraphEdge(
                source_key="hash:abc",
                target_key=bare,
                relation_type="cited_by",
                provider_source="o",
            ),
            Note(user_id=bob, target_type="paper", target_key="doi:10.1/ABC", content="Bob"),
            Note(user_id=alice, target_type="collection", target_key="10.1/ABC", content="Coll"),
        ]
    )
    await db.flush()

    report = await _repair(db)

    assert report.unrepairable == []
    assert await _rows(
        db,
        CollectionPaper.collection_id,
        CollectionPaper.paper_canonical_key,
        CollectionPaper.position,
    ) == sorted([(first, key, 0), (second, key, 2)])
    # Alice's synthetic entry moves to the new key's synthetic group; Bob's
    # client-supplied group is kept.
    assert await _rows(
        db,
        UserLibraryVersion.user_id,
        UserLibraryVersion.paper_canonical_key,
        UserLibraryVersion.paper_group_key,
    ) == sorted([(alice, key, synthetic_group_key(key)), (bob, key, "group:client")])
    assert await _rows(db, UserLibraryEntry.user_id, UserLibraryEntry.paper_group_key) == sorted(
        [(alice, synthetic_group_key(key)), (bob, "group:client")]
    )
    assert await _rows(
        db, UserDismissedPaper.user_id, UserDismissedPaper.paper_canonical_key
    ) == sorted([(alice, key), (bob, key)])
    assert await _rows(
        db, ZoteroLink.user_id, ZoteroLink.local_type, ZoteroLink.local_key, ZoteroLink.zotero_key
    ) == sorted(
        [
            (alice, "collection", "10.1/ABC", "COLL0001"),
            (alice, "paper", key, "CANON001"),
            (bob, "paper", key, "BOB00001"),
        ]
    )
    assert await _rows(
        db, PaperGraphEdge.source_key, PaperGraphEdge.target_key, PaperGraphEdge.relation_type
    ) == sorted(
        [
            (key, "doi:10.2/x", "cites"),
            ("doi:10.2/x", key, "cites"),
            ("hash:abc", key, "cited_by"),
        ]
    )
    assert await _rows(db, Note.user_id, Note.target_type, Note.target_key) == sorted(
        [(alice, "collection", "10.1/ABC"), (bob, "paper", key)]
    )


async def test_keys_of_cached_snapshots_are_left_alone(db):
    user_id = await _user(db)
    # A provider key that is not in the normalized form is authoritative.
    db.add(_cached("doi:10.1/Legacy", "group:legacy"))
    await _pinned(db, user_id, "doi:10.1/Legacy", "group:legacy")
    await db.flush()

    report = await _repair(db)

    assert report.mapped == 0
    assert await _rows(db, UserLibraryVersion.paper_canonical_key) == [("doi:10.1/Legacy",)]


async def test_strong_identifier_keys_are_neither_repaired_nor_reported(db):
    user_id = await _user(db)
    coll_id = await _collection(db, user_id)
    # Uncached, yet valid as stored: reads resolve them through cache aliases.
    keys = [
        "s2:" + "a" * 40,
        "arxiv:2501.00663",
        "pmid:31452104",
        "pmcid:PMC2323736",
        "openalex:W2100837269",
    ]
    for position, key in enumerate(keys):
        db.add(
            CollectionPaper(
                collection_id=coll_id,
                paper_canonical_key=key,
                added_by=user_id,
                position=position,
            )
        )
        await _pinned(db, user_id, key, synthetic_group_key(key))
    await db.flush()

    report = await _repair(db)

    assert (report.mapped, report.unrepairable) == (0, [])
    assert await _rows(db, CollectionPaper.paper_canonical_key) == sorted((k,) for k in keys)
    assert await _rows(db, UserLibraryVersion.paper_canonical_key) == sorted((k,) for k in keys)


async def test_a_real_group_the_version_already_has_is_kept(db):
    user_id = await _user(db)
    db.add(_cached("doi:10.1/v2", "group:paper"))
    await _pinned(db, user_id, "10.1/V1", "group:paper", at=T0)
    await _pinned(db, user_id, "doi:10.1/v2", "group:paper", at=T0.replace(hour=10))
    db.add_all(
        [
            UserPaperTag(
                user_id=user_id,
                paper_canonical_key="10.1/V1",
                tag="v1",
                paper_group_key="group:paper",
            ),
            UserPaperTag(
                user_id=user_id,
                paper_canonical_key="doi:10.1/v2",
                tag="v2",
                paper_group_key="group:paper",
            ),
        ]
    )
    await db.flush()

    await _repair(db)

    # The version keeps the group it already had (a real, client-known one).
    assert await _rows(
        db, UserLibraryVersion.paper_canonical_key, UserLibraryVersion.paper_group_key
    ) == [("doi:10.1/v1", "group:paper"), ("doi:10.1/v2", "group:paper")]
    entry = await db.get(UserLibraryEntry, (user_id, "group:paper"))
    assert entry.primary_canonical_key == "doi:10.1/v1"
    assert await _rows(db, UserPaperTag.paper_canonical_key, UserPaperTag.tag) == [
        ("doi:10.1/v1", "v1"),
        ("doi:10.1/v2", "v2"),
    ]


async def test_version_moving_to_its_real_group_leaves_the_rest_behind(db):
    user_id = await _user(db)
    db.add(_cached("doi:10.1/moved", "group:real"))
    await _pinned(db, user_id, "10.1/MOVED", "group:shared", at=T0)
    await _pinned(db, user_id, "doi:10.1/kept", "group:shared", at=T0.replace(hour=10))
    db.add_all(
        [
            UserPaperTag(
                user_id=user_id,
                paper_canonical_key="10.1/MOVED",
                tag="moved",
                paper_group_key="group:shared",
            ),
            UserPaperTag(
                user_id=user_id,
                paper_canonical_key="doi:10.1/kept",
                tag="kept",
                paper_group_key="group:shared",
            ),
            Note(
                user_id=user_id,
                target_type="paper",
                target_key="10.1/MOVED",
                paper_group_key="group:shared",
                content="moves",
            ),
        ]
    )
    await db.flush()

    await _repair(db)

    assert await _rows(
        db,
        UserLibraryEntry.paper_group_key,
        UserLibraryEntry.primary_canonical_key,
        UserLibraryEntry.created_at,
    ) == [("group:real", "doi:10.1/moved", T0), ("group:shared", "doi:10.1/kept", T0)]
    assert await _rows(db, UserPaperTag.tag, UserPaperTag.paper_group_key) == [
        ("kept", "group:shared"),
        ("moved", "group:real"),
    ]
    assert await _rows(db, Note.target_key, Note.paper_group_key) == [
        ("doi:10.1/moved", "group:real")
    ]


async def test_rekey_user_paper_is_scoped_to_one_user_and_editable_collections(db):
    owner = await _user(db, "owner@example.com")
    editor = await _user(db, "editor@example.com")
    shared = await _collection(db, owner, "Shared", members=[(editor, "editor")])
    viewed = await _collection(db, owner, "Viewed", members=[(editor, "viewer")])
    for coll_id in (shared, viewed):
        db.add(CollectionPaper(collection_id=coll_id, paper_canonical_key=RAW, position=0))
    await _pinned(db, owner, RAW, synthetic_group_key(RAW))
    await _pinned(db, editor, RAW, synthetic_group_key(RAW))
    db.add(UserPaperState(user_id=owner, paper_canonical_key=RAW, state="read"))
    await db.flush()

    moved = await db.run_sync(
        lambda session: key_repair.rekey_user_paper(
            session.connection(),
            user_id=editor,
            old_key=RAW,
            new_key=TNN,
            target_group="group:gnn",
            collection_ids={shared},
        )
    )
    db.expire_all()

    assert moved["collection_papers"] == 1
    assert moved["user_library_versions"] == 1
    assert await _rows(
        db, CollectionPaper.collection_id, CollectionPaper.paper_canonical_key
    ) == sorted([(shared, TNN), (viewed, RAW)])
    assert await _rows(
        db,
        UserLibraryVersion.user_id,
        UserLibraryVersion.paper_canonical_key,
        UserLibraryVersion.paper_group_key,
    ) == sorted([(owner, RAW, synthetic_group_key(RAW)), (editor, TNN, "group:gnn")])
    assert await _rows(db, UserPaperState.user_id, UserPaperState.paper_canonical_key) == [
        (owner, RAW)
    ]


@pytest.mark.parametrize(
    "raw",
    [raw for raw, _doi in VALID]
    + INVALID
    + [RAW, DX, DOUBLE, INVALID_KEY, "hash:abc", " group:abc ", "doi:10.1/a%2Fb", "Doi:10.1/X"]
    + [f"{ch}10.1/X{ch}" for ch in "\u200b\u200c\u200d\u2060\ufeff"],
)
def test_frozen_normalizer_matches_the_live_one(raw):
    assert key_repair.frozen_normalize_paper_key(raw) == normalize_paper_key(raw)


def test_frozen_synthetic_group_matches_the_live_one():
    for key in (TNN, INVALID_KEY, "hash:abc"):
        assert key_repair.frozen_synthetic_group_key(key) == synthetic_group_key(key)
