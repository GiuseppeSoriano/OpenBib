"""Every paper-key boundary normalizes user input; deletes still reach legacy rows."""

import uuid
from datetime import date

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.auth.service import create_access_token, create_session, hash_password, utcnow
from app.collections import service as collections_service
from app.collections.models import CollectionPaper
from app.collections.schemas import CollectionCreate
from app.dependencies import get_db
from app.library import service as library_service
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.main import create_app
from app.notes.models import Note
from app.papers.models import UserDismissedPaper, UserPaperState, UserPaperTag
from app.papers.service import cache_papers
from app.providers.base import Author, PaperMetadata
from app.users.models import User


def _paper(canonical_key: str, group_key: str, title: str = "Boundary Paper") -> PaperMetadata:
    return PaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        title=title,
        authors=[Author(name="Alice Smith")],
        publication_date=date(2024, 1, 1),
        provider_source="openalex",
    )


async def _make_user(db, email: str = "keys@example.com") -> User:
    user = User(
        id=uuid.uuid4(),
        email=email,
        password_hash=hash_password("password123"),
        display_name="Test User",
        email_verified_at=utcnow(),
        terms_version="dev-1",
        privacy_version="dev-1",
    )
    db.add(user)
    await db.flush()
    return user


async def _auth(db, user: User) -> dict[str, str]:
    session, _ = await create_session(db, user.id)
    return {"Authorization": f"Bearer {create_access_token(user.id, session.id)}"}


def _client(db) -> AsyncClient:
    async def override_db():
        yield db

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")


@pytest.mark.asyncio
async def test_state_tag_and_dismiss_routes_store_normalized_keys(db):
    user = await _make_user(db)
    headers = await _auth(db, user)

    async with _client(db) as client:
        state = await client.put(
            "/api/v1/papers/10.1/X/state", json={"state": "reading"}, headers=headers
        )
        states = await client.get("/api/v1/papers/DOI:10.1/x/states", headers=headers)
        tag = await client.post("/api/v1/papers/10.1/X/tags", json={"tag": "gnn"}, headers=headers)
        dismissed = await client.post("/api/v1/papers/10.1/X/dismiss", headers=headers)

    assert state.status_code == 200
    assert state.json()["paper_canonical_key"] == "doi:10.1/x"
    assert [row["state"] for row in states.json()] == ["reading"]
    assert tag.json()["paper_canonical_key"] == "doi:10.1/x"
    assert dismissed.json()["paper_canonical_key"] == "doi:10.1/x"
    assert await db.get(UserPaperState, (user.id, "doi:10.1/x")) is not None
    assert await db.get(UserDismissedPaper, (user.id, "doi:10.1/x")) is not None


@pytest.mark.asyncio
async def test_tag_and_dismiss_deletes_try_the_exact_key_first(db):
    user = await _make_user(db)
    headers = await _auth(db, user)
    db.add(UserPaperTag(user_id=user.id, paper_canonical_key="10.1/Legacy", tag="old"))
    db.add(UserPaperTag(user_id=user.id, paper_canonical_key="doi:10.1/new", tag="new"))
    db.add(UserDismissedPaper(user_id=user.id, paper_canonical_key="10.1/Legacy"))
    await db.flush()

    async with _client(db) as client:
        legacy_tag = await client.delete("/api/v1/papers/10.1/Legacy/tags/old", headers=headers)
        new_tag = await client.delete("/api/v1/papers/10.1/NEW/tags/new", headers=headers)
        undismiss = await client.delete("/api/v1/papers/10.1/Legacy/dismiss", headers=headers)

    assert (legacy_tag.status_code, new_tag.status_code, undismiss.status_code) == (204, 204, 204)
    remaining = (
        await db.execute(select(UserPaperTag).where(UserPaperTag.user_id == user.id))
    ).all()
    assert remaining == []
    assert await db.get(UserDismissedPaper, (user.id, "10.1/Legacy")) is None


@pytest.mark.asyncio
async def test_paper_notes_are_anchored_to_the_normalized_key(db):
    user = await _make_user(db)
    headers = await _auth(db, user)
    await cache_papers(db, [_paper("doi:10.1/x", "group:x")])

    async with _client(db) as client:
        paper_note = await client.post(
            "/api/v1/notes",
            json={"target_type": "paper", "target_key": " DOI:10.1/X ", "content": "Key idea"},
            headers=headers,
        )
        collection_note = await client.post(
            "/api/v1/notes",
            json={"target_type": "collection", "target_key": " Keep As Is ", "content": "x"},
            headers=headers,
        )

    assert paper_note.status_code == 201
    assert paper_note.json()["target_key"] == "doi:10.1/x"
    assert paper_note.json()["paper_group_key"] == "group:x"
    assert collection_note.json()["target_key"] == " Keep As Is "
    notes = (await db.execute(select(Note.target_key).where(Note.user_id == user.id))).all()
    assert sorted(row[0] for row in notes) == [" Keep As Is ", "doi:10.1/x"]


@pytest.mark.asyncio
async def test_library_save_uses_the_cached_group_over_the_client_group(db):
    user = await _make_user(db)
    headers = await _auth(db, user)
    await cache_papers(db, [_paper("doi:10.1/x", "group:real")])

    async with _client(db) as client:
        saved = await client.post(
            "/api/v1/library/entries",
            json={
                "paper_group_key": "group:client",
                "paper_canonical_key": "https://doi.org/10.1/X",
            },
            headers=headers,
        )
        not_a_group = await client.post(
            "/api/v1/library/entries",
            json={"paper_group_key": "doi:10.1/x", "paper_canonical_key": "doi:10.1/x"},
            headers=headers,
        )

    assert saved.status_code == 201
    assert saved.json()["paper_group_key"] == "group:real"
    assert saved.json()["primary_canonical_key"] == "doi:10.1/x"
    assert await db.get(UserLibraryEntry, (user.id, "group:client")) is None
    assert not_a_group.status_code == 422


@pytest.mark.asyncio
async def test_library_save_keeps_an_existing_pin_for_uncached_papers(db):
    user = await _make_user(db)
    headers = await _auth(db, user)
    await library_service.ensure_entry_and_version(db, user.id, "group:first", "doi:10.9/p")

    async with _client(db) as client:
        saved = await client.post(
            "/api/v1/library/entries",
            json={"paper_group_key": "group:other", "paper_canonical_key": "doi:10.9/p"},
            headers=headers,
        )

    assert saved.status_code == 201
    assert saved.json()["paper_group_key"] == "group:first"


@pytest.mark.asyncio
async def test_collection_paper_delete_tries_exact_then_normalized_key(db):
    user = await _make_user(db)
    headers = await _auth(db, user)
    coll = await collections_service.create_collection(db, user.id, CollectionCreate(name="Legacy"))
    db.add(CollectionPaper(collection_id=coll.id, paper_canonical_key="10.1109/TNN.raw"))
    db.add(CollectionPaper(collection_id=coll.id, paper_canonical_key="doi:10.1/x", position=1))
    await db.flush()

    async with _client(db) as client:
        raw = await client.delete(
            f"/api/v1/collections/{coll.id}/papers/10.1109/TNN.raw", headers=headers
        )
        normalized = await client.delete(
            f"/api/v1/collections/{coll.id}/papers/10.1/X", headers=headers
        )
        missing = await client.delete(
            f"/api/v1/collections/{coll.id}/papers/10.1/X", headers=headers
        )

    assert (raw.status_code, normalized.status_code, missing.status_code) == (204, 204, 404)
    rows = (
        await db.execute(select(CollectionPaper).where(CollectionPaper.collection_id == coll.id))
    ).all()
    assert rows == []


@pytest.mark.asyncio
async def test_remove_version_route_is_reachable(db):
    """Regression: DELETE /entries/{g:path} used to shadow this route."""
    user = await _make_user(db)
    headers = await _auth(db, user)
    await library_service.ensure_entry_and_version(db, user.id, "group:multi", "doi:10.1/v1")
    await library_service.add_version(db, user.id, "group:multi", "doi:10.1/v2")

    async with _client(db) as client:
        removed = await client.delete(
            "/api/v1/library/entries/group:multi/versions/doi:10.1/v2", headers=headers
        )
        by_raw_doi = await client.delete(
            "/api/v1/library/entries/group:multi/versions/10.1/V1", headers=headers
        )

    assert removed.status_code == 204
    assert by_raw_doi.status_code == 204
    assert await db.get(UserLibraryEntry, (user.id, "group:multi")) is not None
    pins = (
        await db.execute(select(UserLibraryVersion).where(UserLibraryVersion.user_id == user.id))
    ).all()
    assert pins == []


@pytest.mark.asyncio
async def test_delete_entry_conflict_and_detach_over_http(db):
    user = await _make_user(db)
    headers = await _auth(db, user)
    await cache_papers(db, [_paper("doi:10.1/x", "group:x")])
    coll = await collections_service.create_collection(
        db, user.id, CollectionCreate(name="Reading list")
    )
    await collections_service.add_paper(db, coll.id, user.id, "doi:10.1/x")

    async with _client(db) as client:
        blocked = await client.delete("/api/v1/library/entries/group:x", headers=headers)
        detached = await client.delete(
            "/api/v1/library/entries/group:x", params={"detach": "true"}, headers=headers
        )

    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "entry_in_collections"
    assert blocked.json()["detail"]["collections"] == [{"id": str(coll.id), "name": "Reading list"}]
    assert detached.status_code == 204
    assert await db.get(UserLibraryEntry, (user.id, "group:x")) is None
    assert await db.get(CollectionPaper, (coll.id, "doi:10.1/x")) is None


@pytest.mark.asyncio
async def test_graph_path_keys_are_normalized(db):
    await cache_papers(db, [_paper("doi:10.1/x", "group:x", "Graph Seed")])

    async with _client(db) as client:
        response = await client.get("/api/v1/graph/paper/https://doi.org/10.1/X")

    assert response.status_code == 200
    assert response.json()["active_paper_key"] == "doi:10.1/x"
    assert response.json()["nodes"][0]["label"] == "Graph Seed"
