"""Anonymous-access rules: search, paper details, and graph exploration are
public; library, collections management, and the library graph require auth."""

import uuid
from datetime import date

import pytest
from httpx import ASGITransport, AsyncClient

from app.auth.service import create_access_token, create_session, hash_password, utcnow
from app.collections import service as collections_service
from app.collections.schemas import CollectionCreate, Visibility
from app.dependencies import get_db
from app.main import create_app
from app.papers.service import cache_papers
from app.providers.base import Author, PaperMetadata, SearchResult
from app.users.models import User


def _paper(canonical_key: str, group_key: str, title: str) -> PaperMetadata:
    # No openalex_id / doi → the graph degrades gracefully to no citations,
    # so these tests never touch the network.
    return PaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        title=title,
        authors=[Author(name="Alice Smith")],
        publication_date=date(2024, 1, 1),
        provider_source="openalex",
    )


async def _make_user(db, email: str) -> User:
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


def _make_app(db):
    async def override_db():
        yield db

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    return app


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")


@pytest.mark.asyncio
async def test_search_is_public(db, monkeypatch):
    async def fake_search_all(*args, **kwargs):
        return [
            SearchResult(
                papers=[_paper("hash:pub", "group:pub", "Public Result")],
                total_count=1,
                page=1,
                page_size=20,
                provider="openalex",
            )
        ]

    app = _make_app(db)
    monkeypatch.setattr("app.providers.registry.search_all", fake_search_all)

    async with _client(app) as client:
        response = await client.get("/api/v1/papers/search", params={"q": "anything"})

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_paper_detail_and_paper_graph_are_public(db):
    await cache_papers(db, [_paper("hash:free", "group:free", "Free Paper")])
    app = _make_app(db)

    async with _client(app) as client:
        detail = await client.get("/api/v1/papers/hash:free")
        graph = await client.get("/api/v1/graph/paper/hash:free")

    assert detail.status_code == 200
    assert graph.status_code == 200
    payload = graph.json()
    assert len(payload["nodes"]) == 1
    assert payload["nodes"][0]["selected_version"]["title"] == "Free Paper"


@pytest.mark.asyncio
async def test_graph_expand_is_public_and_skips_user_scoped_persistence(db, monkeypatch):
    saved_lookup = {"called": False}

    async def fake_saved(db_, user_id):
        saved_lookup["called"] = True
        return set()

    captured: dict = {}

    async def fake_expand(db_, redis_, **kwargs):
        captured.update(kwargs)
        from app.graph.schemas import ExpandResponse

        return ExpandResponse(nodes=[], edges=[])

    monkeypatch.setattr("app.graph.service.saved_canonical_keys", fake_saved)
    monkeypatch.setattr("app.graph.service.expand_graph", fake_expand)

    app = _make_app(db)
    async with _client(app) as client:
        response = await client.post(
            "/api/v1/graph/expand",
            json={"from_keys": ["hash:free"], "existing_group_keys": []},
        )

    assert response.status_code == 200
    assert saved_lookup["called"] is False, "anonymous expand must not look up saved keys"
    assert captured["saved_keys"] == set()


@pytest.mark.asyncio
async def test_graph_expand_uses_saved_keys_when_authenticated(db, monkeypatch):
    user = await _make_user(db, "grapher@example.com")

    async def fake_saved(db_, user_id):
        assert str(user_id) == str(user.id)
        return {"doi:10.1/saved"}

    captured: dict = {}

    async def fake_expand(db_, redis_, **kwargs):
        captured.update(kwargs)
        from app.graph.schemas import ExpandResponse

        return ExpandResponse(nodes=[], edges=[])

    monkeypatch.setattr("app.graph.service.saved_canonical_keys", fake_saved)
    monkeypatch.setattr("app.graph.service.expand_graph", fake_expand)

    app = _make_app(db)
    session, _ = await create_session(db, user.id)
    token = create_access_token(user.id, session.id)
    async with _client(app) as client:
        response = await client.post(
            "/api/v1/graph/expand",
            json={"from_keys": ["hash:free"], "existing_group_keys": []},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert captured["saved_keys"] == {"doi:10.1/saved"}


@pytest.mark.asyncio
async def test_user_scoped_endpoints_require_auth(db):
    app = _make_app(db)
    async with _client(app) as client:
        library = await client.get("/api/v1/library/entries")
        collections = await client.get("/api/v1/collections")
        library_graph = await client.get("/api/v1/graph/library")

    assert library.status_code == 401
    assert collections.status_code == 401
    assert library_graph.status_code == 401


@pytest.mark.asyncio
async def test_collection_graph_public_vs_private(db):
    owner = await _make_user(db, "graphowner@example.com")
    public = await collections_service.create_collection(
        db, owner.id, CollectionCreate(name="Open", visibility=Visibility.public)
    )
    private = await collections_service.create_collection(
        db, owner.id, CollectionCreate(name="Closed", visibility=Visibility.private)
    )
    await cache_papers(db, [_paper("hash:collpub", "group:collpub", "Coll Paper")])
    await collections_service.add_paper(db, public.id, owner.id, "hash:collpub")

    app = _make_app(db)
    async with _client(app) as client:
        ok = await client.get(f"/api/v1/graph/collection/{public.id}")
        forbidden = await client.get(f"/api/v1/graph/collection/{private.id}")

    assert ok.status_code == 200
    assert len(ok.json()["nodes"]) == 1
    assert forbidden.status_code == 403
