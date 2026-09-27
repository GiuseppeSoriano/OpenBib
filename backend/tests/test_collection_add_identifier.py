"""Adding a paper by DOI: normalization, resolution, dedupe and coded errors."""

import os
import uuid
from datetime import date
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import create_access_token, create_session, hash_password, utcnow
from app.collections import service as collections_service
from app.collections.models import CollectionPaper
from app.collections.schemas import CollectionCreate, Visibility
from app.common import rate_limit
from app.common.identifiers import synthetic_group_key
from app.dependencies import get_db
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.main import create_app
from app.papers.service import cache_papers
from app.providers.base import Author, PaperMetadata
from app.providers.registry import DoiLookup
from app.users.models import User

# SQLite ignores FOR UPDATE, so only Postgres can prove the user lock is free.
ON_POSTGRES = os.getenv("TEST_DB_URL", "").startswith("postgresql")
TNN = "doi:10.1109/tnn.2008.2005605"
VARIANTS = [
    "10.1109/tnn.2008.2005605",
    "doi:10.1109/tnn.2008.2005605",
    "DOI: 10.1109/TNN.2008.2005605",
    "https://doi.org/10.1109/tnn.2008.2005605",
    "http://dx.doi.org/10.1109/TNN.2008.2005605",
    "  10.1109/TNN.2008.2005605 ",
]


def _paper(canonical_key: str, group_key: str, title: str) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        title=title,
        authors=[Author(name="Franco Scarselli")],
        publication_date=date(2009, 1, 1),
        doi=canonical_key.removeprefix("doi:"),
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


async def _auth(db, user: User) -> dict[str, str]:
    session, _ = await create_session(db, user.id)
    return {"Authorization": f"Bearer {create_access_token(user.id, session.id)}"}


def _client(db) -> AsyncClient:
    async def override_db():
        yield db

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")


async def _setup(db, email: str = "adder@example.com"):
    user = await _make_user(db, email)
    coll = await collections_service.create_collection(
        db, user.id, CollectionCreate(name="Audit", visibility=Visibility.private)
    )
    return user, coll, await _auth(db, user)


async def _count(db, model, **filters) -> int:
    stmt = select(func.count()).select_from(model)
    for name, value in filters.items():
        stmt = stmt.where(getattr(model, name) == value)
    return (await db.execute(stmt)).scalar_one()


def _resolver(result: DoiLookup, calls: list[str] | None = None):
    async def resolve(doi: str, **_kwargs):
        if calls is not None:
            calls.append(doi)
        return result

    return resolve


@pytest.mark.asyncio
async def test_doi_variants_converge_on_one_resolved_row(db, monkeypatch):
    calls: list[str] = []
    found = DoiLookup("found", _paper(TNN, "group:gnn", "The Graph Neural Network Model"))
    monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(found, calls))
    user, coll, headers = await _setup(db)

    async with _client(db) as client:
        responses = [
            await client.post(
                f"/api/v1/collections/{coll.id}/papers",
                json={"paper_canonical_key": variant},
                headers=headers,
            )
            for variant in VARIANTS
        ]
        listed = await client.get(f"/api/v1/collections/{coll.id}", headers=headers)

    first = responses[0]
    assert first.status_code == 201
    body = first.json()
    assert body["paper_canonical_key"] == TNN
    assert body["paper_group_key"] == "group:gnn"
    assert body["resolved"] is True
    assert body["paper"]["title"] == "The Graph Neural Network Model"
    for duplicate in responses[1:]:
        assert duplicate.status_code == 409
        assert duplicate.json()["detail"]["code"] == "already_in_collection"
        assert duplicate.json()["detail"]["canonical_key"] == TNN
    assert calls == ["10.1109/tnn.2008.2005605"]
    assert listed.json()["paper_count"] == 1
    assert await _count(db, CollectionPaper, collection_id=coll.id) == 1
    assert await _count(db, UserLibraryEntry, user_id=user.id) == 1
    pin = await db.get(UserLibraryVersion, (user.id, TNN))
    assert pin.paper_group_key == "group:gnn"


@pytest.mark.asyncio
async def test_invalid_identifier_is_rejected_without_writes(db):
    user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": "not-a-doi"},
            headers=headers,
        )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_identifier"
    assert response.json()["detail"]["value"] == "not-a-doi"
    assert await _count(db, CollectionPaper, collection_id=coll.id) == 0
    assert await _count(db, UserLibraryEntry, user_id=user.id) == 0


@pytest.mark.asyncio
async def test_unknown_doi_is_rejected_without_writes(db, monkeypatch):
    monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(DoiLookup("not_found")))
    user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": "https://doi.org/10.5555/missing"},
            headers=headers,
        )

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "doi_not_found",
        "message": response.json()["detail"]["message"],
        "doi": "10.5555/missing",
    }
    assert await _count(db, CollectionPaper, collection_id=coll.id) == 0
    assert await _count(db, UserLibraryEntry, user_id=user.id) == 0


@pytest.mark.asyncio
async def test_provider_outage_stores_the_paper_as_pending(db):
    # The autouse fixture empties the provider chain: resolution is unavailable.
    user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": "DOI 10.9/Pending"},
            headers=headers,
        )
        listed = await client.get(f"/api/v1/collections/{coll.id}/papers", headers=headers)

    assert response.status_code == 201
    body = response.json()
    assert body["paper_canonical_key"] == "doi:10.9/pending"
    assert body["resolved"] is False
    assert body["paper"] is None
    assert [row["resolved"] for row in listed.json()] == [False]
    pin = await db.get(UserLibraryVersion, (user.id, "doi:10.9/pending"))
    assert pin.paper_group_key == synthetic_group_key("doi:10.9/pending")


@pytest.mark.asyncio
async def test_registered_doi_without_metadata_is_stored_as_pending(db, monkeypatch):
    from app.providers import registry

    class Miss:
        name = "miss"

        async def lookup_by_doi(self, doi):
            return None

    async def handle_exists(doi):
        return True

    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", [Miss(), Miss()])
    monkeypatch.setattr(registry, "doi_handle_exists", handle_exists)
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": "10.5281/zenodo.123"},
            headers=headers,
        )

    assert response.status_code == 201
    assert response.json()["resolved"] is False


@pytest.mark.asyncio
async def test_provider_alias_is_stored_under_the_returned_key(db, monkeypatch):
    alias = DoiLookup("found", _paper("doi:10.1/canonical", "group:alias", "Aliased"))
    monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(alias))
    user, coll, headers = await _setup(db)

    async with _client(db) as client:
        first = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": "10.1/alias"},
            headers=headers,
        )
        again = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": "10.1/alias"},
            headers=headers,
        )

    assert first.status_code == 201
    assert first.json()["paper_canonical_key"] == "doi:10.1/canonical"
    assert again.status_code == 409
    assert again.json()["detail"]["canonical_key"] == "doi:10.1/canonical"
    pin = await db.get(UserLibraryVersion, (user.id, "doi:10.1/canonical"))
    assert pin.paper_group_key == "group:alias"


@pytest.mark.asyncio
async def test_real_group_replaces_an_earlier_synthetic_entry(db, monkeypatch):
    user, coll, headers = await _setup(db)
    other = await collections_service.create_collection(
        db, user.id, CollectionCreate(name="Other", visibility=Visibility.private)
    )

    async with _client(db) as client:
        pending = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": TNN},
            headers=headers,
        )
        found = DoiLookup("found", _paper(TNN, "group:gnn", "The Graph Neural Network Model"))
        monkeypatch.setattr("app.providers.registry.resolve_doi", _resolver(found))
        resolved = await client.post(
            f"/api/v1/collections/{other.id}/papers",
            json={"paper_canonical_key": TNN},
            headers=headers,
        )

    assert pending.json()["resolved"] is False
    assert resolved.json()["resolved"] is True
    entries = (
        await db.execute(
            select(UserLibraryEntry.paper_group_key).where(UserLibraryEntry.user_id == user.id)
        )
    ).all()
    assert [row[0] for row in entries] == ["group:gnn"]


@pytest.mark.asyncio
async def test_hash_keys_must_already_be_known(db):
    await cache_papers(db, [_paper("hash:collpub", "group:collpub", "Known")])
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        unknown = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": "hash:deadbeef"},
            headers=headers,
        )
        known = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": "hash:collpub"},
            headers=headers,
        )

    assert unknown.status_code == 422
    assert unknown.json()["detail"]["code"] == "unknown_paper_key"
    assert known.status_code == 201
    assert known.json()["resolved"] is True


@pytest.mark.asyncio
async def test_non_editor_cannot_add(db):
    _owner, coll, _headers = await _setup(db)
    stranger = await _make_user(db, "stranger@example.com")
    headers = await _auth(db, stranger)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": TNN},
            headers=headers,
        )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_adds_are_rate_limited(db, monkeypatch):
    # Freeze the bucket clock so slow requests cannot refill tokens mid-test.
    monkeypatch.setattr(rate_limit, "time", SimpleNamespace(time=lambda: 1_700_000_000.0))
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        statuses = [
            (
                await client.post(
                    f"/api/v1/collections/{coll.id}/papers",
                    json={"paper_canonical_key": "not-a-doi"},
                    headers=headers,
                )
            ).status_code
            for _ in range(61)
        ]

    assert statuses[:60] == [422] * 60
    assert statuses[60] == 429


@pytest.mark.asyncio
async def test_no_transaction_or_user_lock_is_held_during_resolution(db, engine, monkeypatch):
    user, coll, headers = await _setup(db)
    observed: dict[str, bool] = {}

    async def resolve(doi: str, **_kwargs):
        observed["in_transaction"] = db.in_transaction()
        if ON_POSTGRES:
            async with AsyncSession(engine) as other:
                locked = await other.execute(
                    text("SELECT id FROM users WHERE id = :id FOR UPDATE NOWAIT"),
                    {"id": user.id},
                )
                observed["lock_free"] = locked.first() is not None
                await other.rollback()
        return DoiLookup("found", _paper(TNN, "group:gnn", "The Graph Neural Network Model"))

    monkeypatch.setattr("app.providers.registry.resolve_doi", resolve)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/papers",
            json={"paper_canonical_key": TNN},
            headers=headers,
        )

    assert response.status_code == 201
    assert observed["in_transaction"] is False
    if ON_POSTGRES:
        assert observed["lock_free"] is True
