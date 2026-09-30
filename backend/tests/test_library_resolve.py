"""POST /library/resolve: retry and correct stored paper identifiers."""

from __future__ import annotations

import os
import uuid
from datetime import date
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import create_access_token, create_session, hash_password, utcnow
from app.collections.models import Collection, CollectionMember, CollectionPaper
from app.common import rate_limit
from app.common.identifiers import synthetic_group_key
from app.dependencies import get_db
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.main import create_app
from app.notes.models import Note
from app.papers.models import UserPaperState, UserPaperTag
from app.papers.service import cache_papers
from app.providers.base import Author, PaperMetadata
from app.providers.registry import DoiLookup
from app.users.models import User

ON_POSTGRES = os.getenv("TEST_DB_URL", "").startswith("postgresql")
TNN = "doi:10.1109/tnn.2008.2005605"
RAW = "10.1109/tnn.2008.2005605"
RESOLVE = "/api/v1/library/resolve"


def _paper(canonical_key: str, group_key: str) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        title="The Graph Neural Network Model",
        authors=[Author(name="Franco Scarselli")],
        publication_date=date(2009, 1, 1),
        doi=canonical_key.removeprefix("doi:"),
        provider_source="openalex",
    )


async def _user(db, email: str = "resolver@example.com") -> tuple[uuid.UUID, dict[str, str]]:
    user = User(
        id=uuid.uuid4(),
        email=email,
        password_hash=hash_password("password123"),
        display_name="Resolver",
        email_verified_at=utcnow(),
        terms_version="dev-1",
        privacy_version="dev-1",
    )
    db.add(user)
    await db.flush()
    session, _ = await create_session(db, user.id)
    return user.id, {"Authorization": f"Bearer {create_access_token(user.id, session.id)}"}


async def _collection(db, owner_id: uuid.UUID, members=()) -> uuid.UUID:
    coll = Collection(id=uuid.uuid4(), owner_id=owner_id, name="Audit")
    db.add(coll)
    await db.flush()
    db.add(CollectionMember(collection_id=coll.id, user_id=owner_id, role="owner"))
    for member_id, role in members:
        db.add(CollectionMember(collection_id=coll.id, user_id=member_id, role=role))
    await db.flush()
    return coll.id


async def _stored(db, user_id, key, *, coll_id=None, group=None, position=0) -> None:
    """A paper as stored before normalization: collection row plus pin."""
    group = group or synthetic_group_key(key)
    if coll_id is not None:
        db.add(
            CollectionPaper(
                collection_id=coll_id, paper_canonical_key=key, added_by=user_id, position=position
            )
        )
    if await db.get(UserLibraryEntry, (user_id, group)) is None:
        db.add(UserLibraryEntry(user_id=user_id, paper_group_key=group, primary_canonical_key=key))
        await db.flush()
    db.add(UserLibraryVersion(user_id=user_id, paper_canonical_key=key, paper_group_key=group))
    await db.flush()


def _client(db) -> AsyncClient:
    async def override_db():
        yield db

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")


def _resolver(result: DoiLookup, calls: list[str] | None = None):
    async def resolve(doi: str, **_kwargs):
        if calls is not None:
            calls.append(doi)
        return result

    return resolve


async def _rows(db, *columns, **filters):
    stmt = select(*columns)
    for name, value in filters.items():
        stmt = stmt.where(getattr(columns[0].class_, name) == value)
    return sorted(tuple(row) for row in (await db.execute(stmt)).all())


async def test_synthetic_entry_reanchors_once_metadata_is_cached(db, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(DoiLookup("found"), calls))
    user_id, headers = await _user(db)
    coll_id = await _collection(db, user_id)
    await _stored(db, user_id, TNN, coll_id=coll_id)
    await cache_papers(db, [_paper(TNN, "group:gnn")])

    async with _client(db) as client:
        response = await client.post(RESOLVE, json={"paper_canonical_key": TNN}, headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "resolved"
    assert body["previous_key"] == body["canonical_key"] == TNN
    assert body["paper_group_key"] == "group:gnn"
    assert body["paper"]["title"] == "The Graph Neural Network Model"
    assert body["moved"] == {}
    assert calls == []
    assert await _rows(db, UserLibraryEntry.paper_group_key, user_id=user_id) == [("group:gnn",)]


async def test_raw_key_is_rekeyed_across_every_user_row(db, monkeypatch):
    found = DoiLookup("found", _paper(TNN, "group:gnn"))
    monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(found))
    user_id, headers = await _user(db)
    coll_id = await _collection(db, user_id)
    await _stored(db, user_id, RAW, coll_id=coll_id)
    db.add_all(
        [
            UserPaperState(user_id=user_id, paper_canonical_key=RAW, state="reading"),
            UserPaperTag(
                user_id=user_id,
                paper_canonical_key=RAW,
                tag="gnn",
                paper_group_key=synthetic_group_key(RAW),
            ),
            Note(
                user_id=user_id,
                target_type="paper",
                target_key=RAW,
                paper_group_key=synthetic_group_key(RAW),
                content="Raw",
            ),
        ]
    )
    await db.flush()

    async with _client(db) as client:
        response = await client.post(RESOLVE, json={"paper_canonical_key": RAW}, headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert (body["status"], body["previous_key"], body["canonical_key"]) == ("resolved", RAW, TNN)
    assert body["paper_group_key"] == "group:gnn"
    assert body["paper"]["doi"] == "10.1109/tnn.2008.2005605"
    assert body["moved"]["collection_papers"] == 1
    assert body["moved"]["user_library_versions"] == 1
    assert await _rows(db, CollectionPaper.paper_canonical_key) == [(TNN,)]
    assert await _rows(
        db, UserLibraryVersion.paper_canonical_key, UserLibraryVersion.paper_group_key
    ) == [(TNN, "group:gnn")]
    assert await _rows(
        db, UserLibraryEntry.paper_group_key, UserLibraryEntry.primary_canonical_key
    ) == [("group:gnn", TNN)]
    assert await _rows(db, UserPaperState.paper_canonical_key, UserPaperState.state) == [
        (TNN, "reading")
    ]
    assert await _rows(db, UserPaperTag.paper_canonical_key, UserPaperTag.paper_group_key) == [
        (TNN, "group:gnn")
    ]
    assert await _rows(db, Note.target_key, Note.paper_group_key) == [(TNN, "group:gnn")]


async def test_replacement_corrects_an_invalid_key_and_merges(db, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(DoiLookup("found"), calls))
    user_id, headers = await _user(db)
    coll_id = await _collection(db, user_id)
    await cache_papers(db, [_paper(TNN, "group:gnn")])
    await _stored(db, user_id, TNN, coll_id=coll_id, group="group:gnn", position=0)
    await _stored(db, user_id, "doi:not-a-doi", coll_id=coll_id, position=1)

    async with _client(db) as client:
        invalid = await client.post(
            RESOLVE, json={"paper_canonical_key": "doi:not-a-doi"}, headers=headers
        )
        bad_replacement = await client.post(
            RESOLVE,
            json={"paper_canonical_key": "doi:not-a-doi", "replacement": "still not a doi"},
            headers=headers,
        )
        response = await client.post(
            RESOLVE,
            json={"paper_canonical_key": "doi:not-a-doi", "replacement": f"https://doi.org/{RAW}"},
            headers=headers,
        )

    assert invalid.status_code == 422
    assert invalid.json()["detail"]["code"] == "invalid_identifier"
    assert invalid.json()["detail"]["value"] == "doi:not-a-doi"
    assert bad_replacement.status_code == 422
    assert bad_replacement.json()["detail"]["code"] == "invalid_identifier"
    assert response.status_code == 200
    body = response.json()
    assert (body["status"], body["previous_key"], body["canonical_key"]) == (
        "resolved",
        "doi:not-a-doi",
        TNN,
    )
    assert body["moved"]["collection_papers_merged"] == 1
    assert calls == []
    assert await _rows(db, CollectionPaper.paper_canonical_key, CollectionPaper.position) == [
        (TNN, 0)
    ]
    assert await _rows(
        db, UserLibraryVersion.paper_canonical_key, UserLibraryVersion.paper_group_key
    ) == [(TNN, "group:gnn")]
    assert await _rows(db, UserLibraryEntry.paper_group_key) == [("group:gnn",)]


async def test_unknown_doi_changes_nothing(db, monkeypatch):
    monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(DoiLookup("not_found")))
    user_id, headers = await _user(db)
    coll_id = await _collection(db, user_id)
    await _stored(db, user_id, "10.5555/Missing", coll_id=coll_id)

    async with _client(db) as client:
        response = await client.post(
            RESOLVE, json={"paper_canonical_key": "10.5555/Missing"}, headers=headers
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "not_found"
    assert body["previous_key"] == body["canonical_key"] == "10.5555/Missing"
    assert body["paper_group_key"] == synthetic_group_key("10.5555/Missing")
    assert body["paper"] is None
    assert body["moved"] == {}
    assert await _rows(db, CollectionPaper.paper_canonical_key) == [("10.5555/Missing",)]
    assert await _rows(db, UserLibraryVersion.paper_canonical_key) == [("10.5555/Missing",)]


async def test_unavailable_only_normalizes_a_legacy_key(db):
    # The autouse fixture empties the provider chain: resolution is unavailable.
    user_id, headers = await _user(db)
    coll_id = await _collection(db, user_id)
    await _stored(db, user_id, "doi:10.9/pending", coll_id=coll_id, position=0)
    await _stored(db, user_id, "DOI:10.9/Legacy", coll_id=coll_id, position=1)

    async with _client(db) as client:
        pending = await client.post(
            RESOLVE, json={"paper_canonical_key": "doi:10.9/pending"}, headers=headers
        )
        legacy = await client.post(
            RESOLVE, json={"paper_canonical_key": "DOI:10.9/Legacy"}, headers=headers
        )

    assert pending.status_code == 200
    assert pending.json()["status"] == "unavailable"
    assert pending.json()["canonical_key"] == "doi:10.9/pending"
    assert pending.json()["moved"] == {}
    assert legacy.status_code == 200
    body = legacy.json()
    assert (body["status"], body["canonical_key"]) == ("unavailable", "doi:10.9/legacy")
    assert body["paper_group_key"] == synthetic_group_key("doi:10.9/legacy")
    assert body["paper"] is None
    assert await _rows(db, CollectionPaper.paper_canonical_key) == [
        ("doi:10.9/legacy",),
        ("doi:10.9/pending",),
    ]
    assert await _rows(
        db, UserLibraryVersion.paper_canonical_key, UserLibraryVersion.paper_group_key
    ) == sorted(
        [
            ("doi:10.9/legacy", synthetic_group_key("doi:10.9/legacy")),
            ("doi:10.9/pending", synthetic_group_key("doi:10.9/pending")),
        ]
    )


async def test_collections_the_caller_cannot_edit_are_untouched(db, monkeypatch):
    found = DoiLookup("found", _paper(TNN, "group:gnn"))
    monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(found))
    owner_id, _owner_headers = await _user(db, "owner@example.com")
    viewer_id, headers = await _user(db, "viewer@example.com")
    theirs = await _collection(db, owner_id, members=[(viewer_id, "viewer")])
    shared = await _collection(db, owner_id, members=[(viewer_id, "editor")])
    mine = await _collection(db, viewer_id)
    await _stored(db, owner_id, RAW, coll_id=theirs)
    db.add(CollectionPaper(collection_id=shared, paper_canonical_key=RAW, position=0))
    await _stored(db, viewer_id, RAW, coll_id=mine)

    async with _client(db) as client:
        response = await client.post(RESOLVE, json={"paper_canonical_key": RAW}, headers=headers)

    assert response.status_code == 200
    assert response.json()["moved"]["collection_papers"] == 2
    assert await _rows(
        db, CollectionPaper.collection_id, CollectionPaper.paper_canonical_key
    ) == sorted([(theirs, RAW), (shared, TNN), (mine, TNN)])
    assert await _rows(
        db,
        UserLibraryVersion.user_id,
        UserLibraryVersion.paper_canonical_key,
        UserLibraryVersion.paper_group_key,
    ) == sorted([(owner_id, RAW, synthetic_group_key(RAW)), (viewer_id, TNN, "group:gnn")])


async def test_editor_without_a_pin_can_resolve_a_collection_row(db, engine, monkeypatch):
    found = DoiLookup("found", _paper(TNN, "group:gnn"))
    monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(found))
    owner_id, _owner_headers = await _user(db, "owner@example.com")
    editor_id, headers = await _user(db, "editor@example.com")
    shared = await _collection(db, owner_id, members=[(editor_id, "editor")])
    await _stored(db, owner_id, RAW, coll_id=shared)

    async with _client(db) as client:
        response = await client.post(RESOLVE, json={"paper_canonical_key": RAW}, headers=headers)

    assert response.status_code == 200
    body = response.json()
    # The moved row keeps a Library entry behind it for the editor.
    assert (body["canonical_key"], body["paper_group_key"]) == (TNN, "group:gnn")
    assert await _rows(db, CollectionPaper.paper_canonical_key) == [(TNN,)]
    # The owner's own Library pin is theirs to resolve.
    assert await _rows(
        db, UserLibraryVersion.user_id, UserLibraryVersion.paper_canonical_key
    ) == sorted([(owner_id, RAW), (editor_id, TNN)])
    assert await _rows(db, UserLibraryEntry.paper_group_key, user_id=editor_id) == [("group:gnn",)]
    if ON_POSTGRES:
        # The re-key ran under the collection row lock, still held by the
        # uncommitted test session.
        async with AsyncSession(engine) as other:
            with pytest.raises(DBAPIError):
                await other.execute(
                    text("SELECT id FROM collections WHERE id = :id FOR UPDATE NOWAIT"),
                    {"id": shared},
                )
            await other.rollback()


async def test_requires_authentication(db):
    async with _client(db) as client:
        response = await client.post(RESOLVE, json={"paper_canonical_key": RAW})

    assert response.status_code == 401


async def test_paper_outside_the_callers_scope_is_not_in_library(db):
    owner_id, _owner_headers = await _user(db, "owner@example.com")
    _stranger_id, headers = await _user(db, "stranger@example.com")
    await _stored(db, owner_id, RAW, coll_id=await _collection(db, owner_id))

    async with _client(db) as client:
        response = await client.post(RESOLVE, json={"paper_canonical_key": RAW}, headers=headers)

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "not_in_library"


async def test_resolve_is_rate_limited(db, monkeypatch):
    # Freeze the bucket clock so slow requests cannot refill tokens mid-test.
    monkeypatch.setattr(rate_limit, "time", SimpleNamespace(time=lambda: 1_700_000_000.0))
    _user_id, headers = await _user(db)

    async with _client(db) as client:
        statuses = [
            (
                await client.post(RESOLVE, json={"paper_canonical_key": RAW}, headers=headers)
            ).status_code
            for _ in range(31)
        ]

    assert statuses[:30] == [404] * 30
    assert statuses[30] == 429


async def test_no_transaction_or_user_lock_is_held_during_resolution(db, engine, monkeypatch):
    user_id, headers = await _user(db)
    await _stored(db, user_id, RAW, coll_id=await _collection(db, user_id))
    observed: dict[str, bool] = {}

    async def resolve(doi: str, **_kwargs):
        observed["in_transaction"] = db.in_transaction()
        if ON_POSTGRES:
            async with AsyncSession(engine) as other:
                locked = await other.execute(
                    text("SELECT id FROM users WHERE id = :id FOR UPDATE NOWAIT"),
                    {"id": user_id},
                )
                observed["lock_free"] = locked.first() is not None
                await other.rollback()
        return DoiLookup("found", _paper(TNN, "group:gnn"))

    monkeypatch.setattr("app.providers.registry.resolve_doi", resolve)

    async with _client(db) as client:
        response = await client.post(RESOLVE, json={"paper_canonical_key": RAW}, headers=headers)

    assert response.status_code == 200
    assert response.json()["canonical_key"] == TNN
    assert observed["in_transaction"] is False
    if ON_POSTGRES:
        assert observed["lock_free"] is True


async def test_raw_doi_of_a_paper_cached_under_s2_moves_onto_that_key(db, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(DoiLookup("found"), calls))
    user_id, headers = await _user(db)
    coll_id = await _collection(db, user_id)
    s2_key = "s2:" + "e" * 40
    snapshot = _paper(TNN, "group:gnn")
    snapshot.canonical_key = s2_key
    snapshot.semantic_scholar_id = "e" * 40
    await cache_papers(db, [snapshot])
    await _stored(db, user_id, RAW, coll_id=coll_id)

    async with _client(db) as client:
        response = await client.post(RESOLVE, json={"paper_canonical_key": RAW}, headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert (body["status"], body["canonical_key"], body["paper_group_key"]) == (
        "resolved",
        s2_key,
        "group:gnn",
    )
    assert calls == []
    assert await _rows(db, CollectionPaper.paper_canonical_key) == [(s2_key,)]
    assert await _rows(
        db, UserLibraryVersion.paper_canonical_key, UserLibraryVersion.paper_group_key
    ) == [(s2_key, "group:gnn")]


async def test_other_identifiers_resolve_or_change_nothing(db, monkeypatch):
    user_id, headers = await _user(db)
    coll_id = await _collection(db, user_id)
    await _stored(db, user_id, "doi:not-a-doi", coll_id=coll_id)
    s2_id = "f" * 40
    record = PaperMetadata(
        canonical_key=f"s2:{s2_id}",
        paper_group_key="group:s2only",
        title="Only on Semantic Scholar",
        semantic_scholar_id=s2_id,
        provider_source="semantic_scholar",
    )
    calls: list[str] = []

    async def resolve_id(identifier: str):
        calls.append(identifier)
        return DoiLookup("found", record)

    async with _client(db) as client:
        # The autouse fixture leaves the provider unconfigured, and only a DOI
        # may be kept as pending: nothing moves.
        unavailable = await client.post(
            RESOLVE,
            json={"paper_canonical_key": "doi:not-a-doi", "replacement": "arXiv:2501.00663v2"},
            headers=headers,
        )
        monkeypatch.setattr("app.providers.registry.resolve_id", resolve_id)
        link = f"https://www.semanticscholar.org/paper/Only-on-S2/{s2_id.upper()}"
        resolved = await client.post(
            RESOLVE,
            json={"paper_canonical_key": "doi:not-a-doi", "replacement": link},
            headers=headers,
        )

    assert unavailable.status_code == 200
    assert (unavailable.json()["status"], unavailable.json()["canonical_key"]) == (
        "unavailable",
        "doi:not-a-doi",
    )
    assert unavailable.json()["moved"] == {}
    assert resolved.status_code == 200
    assert (resolved.json()["status"], resolved.json()["canonical_key"]) == (
        "resolved",
        f"s2:{s2_id}",
    )
    assert calls == [f"s2:{s2_id}"]
    assert await _rows(db, CollectionPaper.paper_canonical_key) == [(f"s2:{s2_id}",)]
    assert await _rows(
        db, UserLibraryVersion.paper_canonical_key, UserLibraryVersion.paper_group_key
    ) == [(f"s2:{s2_id}", "group:s2only")]


async def test_edit_rights_are_rechecked_after_resolution(db, monkeypatch):
    owner_id, _owner_headers = await _user(db, "owner@example.com")
    editor_id, headers = await _user(db, "editor@example.com")
    shared = await _collection(db, owner_id, members=[(editor_id, "editor")])
    await _stored(db, owner_id, RAW, coll_id=shared)

    async def revoke_then_find(doi: str, **_kwargs):
        # The owner removes the editor while the provider is answering.
        await db.execute(
            delete(CollectionMember).where(
                CollectionMember.collection_id == shared, CollectionMember.user_id == editor_id
            )
        )
        await db.commit()
        return DoiLookup("found", _paper(TNN, "group:gnn"))

    monkeypatch.setattr("app.providers.registry.resolve_doi", revoke_then_find)

    async with _client(db) as client:
        response = await client.post(RESOLVE, json={"paper_canonical_key": RAW}, headers=headers)

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "not_in_library"
    assert await _rows(db, CollectionPaper.paper_canonical_key) == [(RAW,)]


async def test_collections_are_locked_before_the_snapshot_is_stored(db, monkeypatch):
    from app.library import service as library_service

    order: list[str] = []
    lock, store = library_service._lock_editable_collections, library_service.store_paper

    async def recording_lock(*args):
        order.append("collections")
        return await lock(*args)

    async def recording_store(*args):
        order.append("snapshot")
        return await store(*args)

    monkeypatch.setattr(library_service, "_lock_editable_collections", recording_lock)
    monkeypatch.setattr(library_service, "store_paper", recording_store)
    monkeypatch.setattr(
        "app.providers.registry.resolve_doi",
        _resolver(DoiLookup("found", _paper(TNN, "group:gnn"))),
    )
    user_id, headers = await _user(db)
    coll_id = await _collection(db, user_id)
    await _stored(db, user_id, RAW, coll_id=coll_id)

    async with _client(db) as client:
        response = await client.post(RESOLVE, json={"paper_canonical_key": RAW}, headers=headers)

    assert response.status_code == 200
    assert response.json()["canonical_key"] == TNN
    # The lock order of adding a paper (user row, collections, cached row), so
    # a concurrent add of the same paper cannot deadlock with this re-key.
    assert order == ["collections", "snapshot"]
