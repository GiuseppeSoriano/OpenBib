"""Batch import: per-line results, dedupe, resolution and idempotent re-import."""

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
from app.collections.schemas import CollectionCreate
from app.common import rate_limit
from app.dependencies import get_db
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.main import create_app
from app.papers.service import cache_papers, get_cached_paper
from app.providers.base import Author, PaperMetadata
from app.providers.registry import DoiLookup
from app.users.models import User

ON_POSTGRES = os.getenv("TEST_DB_URL", "").startswith("postgresql")
MIXED = ["10.1/a", "doi:10.1/A", "https://doi.org/10.1/b", "not-a-doi", "10.1/missing"]


def _paper(canonical_key: str, group_key: str, title: str) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        title=title,
        authors=[Author(name="Alice Smith")],
        publication_date=date(2024, 1, 1),
        doi=canonical_key.removeprefix("doi:") if canonical_key.startswith("doi:") else None,
        provider_source="crossref",
    )


async def fake_resolve_doi(doi: str, **_kwargs) -> DoiLookup:
    if doi == "10.1/missing":
        return DoiLookup("not_found")
    return DoiLookup("found", _paper(f"doi:{doi}", f"group:{doi[-1]}", f"Paper {doi[-1]}"))


def _batch(resolve, calls: list[list[str]] | None = None):
    """A ``registry.resolve_dois`` stand-in built on a per-DOI resolver."""

    async def resolve_dois(dois: list[str], **_kwargs) -> dict[str, DoiLookup]:
        if calls is not None:
            calls.append(list(dois))
        return {doi: await resolve(doi) for doi in dois}

    return resolve_dois


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


async def _setup(db, email: str = "importer@example.com"):
    user = await _make_user(db, email)
    coll = await collections_service.create_collection(
        db, user.id, CollectionCreate(name="Imports")
    )
    return user, coll, await _auth(db, user)


async def _count(db, model, **filters) -> int:
    stmt = select(func.count()).select_from(model)
    for name, value in filters.items():
        stmt = stmt.where(getattr(model, name) == value)
    return (await db.execute(stmt)).scalar_one()


@pytest.mark.asyncio
async def test_mixed_batch_gets_per_line_statuses(db, monkeypatch):
    monkeypatch.setattr("app.providers.registry.resolve_dois", _batch(fake_resolve_doi))
    user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/dois",
            json={"dois": [*MIXED[:3], "", "  ", *MIXED[3:]]},
            headers=headers,
        )

    assert response.status_code == 200
    body = response.json()
    assert [(r["line"], r["status"]) for r in body["results"]] == [
        (1, "added"),
        (2, "duplicate"),
        (3, "added"),
        (6, "invalid"),
        (7, "not_found"),
    ]
    assert body["results"][0]["canonical_key"] == "doi:10.1/a"
    assert body["results"][0]["title"] == "Paper a"
    assert body["results"][3]["input"] == "not-a-doi"
    assert {k: body[k] for k in ("added", "duplicate", "invalid", "not_found", "unresolved")} == {
        "added": 2,
        "duplicate": 1,
        "invalid": 1,
        "not_found": 1,
        "unresolved": 0,
    }
    assert body["total"] == 5
    assert body["skipped"] == body["duplicate"]

    assert await _count(db, CollectionPaper, collection_id=coll.id) == 2
    pins = (
        await db.execute(
            select(UserLibraryVersion.paper_canonical_key, UserLibraryVersion.paper_group_key)
            .where(UserLibraryVersion.user_id == user.id)
            .order_by(UserLibraryVersion.paper_canonical_key)
        )
    ).all()
    assert [tuple(row) for row in pins] == [("doi:10.1/a", "group:a"), ("doi:10.1/b", "group:b")]


@pytest.mark.asyncio
async def test_reimport_is_all_duplicates_and_changes_nothing(db, monkeypatch):
    monkeypatch.setattr("app.providers.registry.resolve_dois", _batch(fake_resolve_doi))
    user, coll, headers = await _setup(db)

    async with _client(db) as client:
        await client.post(
            f"/api/v1/collections/{coll.id}/import/dois", json={"dois": MIXED}, headers=headers
        )
        again = await client.post(
            f"/api/v1/collections/{coll.id}/import/dois",
            json={"dois": ["10.1/A", "https://doi.org/10.1/b"]},
            headers=headers,
        )

    assert [r["status"] for r in again.json()["results"]] == ["duplicate", "duplicate"]
    assert again.json()["added"] == 0
    assert await _count(db, CollectionPaper, collection_id=coll.id) == 2
    assert await _count(db, UserLibraryEntry, user_id=user.id) == 2


@pytest.mark.asyncio
async def test_alias_dois_resolving_to_one_record_are_deduped(db, monkeypatch):
    async def alias_resolve(doi: str, **_kwargs) -> DoiLookup:
        return DoiLookup("found", _paper("doi:10.1/primary", "group:primary", "Primary"))

    monkeypatch.setattr("app.providers.registry.resolve_dois", _batch(alias_resolve))
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/dois",
            json={"dois": ["10.1/alias", "10.1/primary"]},
            headers=headers,
        )

    assert response.status_code == 200
    assert [(r["status"], r["canonical_key"]) for r in response.json()["results"]] == [
        ("added", "doi:10.1/primary"),
        ("duplicate", "doi:10.1/primary"),
    ]
    assert await _count(db, CollectionPaper, collection_id=coll.id) == 1


@pytest.mark.asyncio
async def test_cache_papers_merges_repeated_keys(db):
    paper = _paper("doi:10.1/twice", "group:twice", "Twice")

    await cache_papers(db, [paper, paper])

    assert (await get_cached_paper(db, "doi:10.1/twice")).title == "Twice"


@pytest.mark.asyncio
async def test_provider_outage_inserts_unresolved_rows(db):
    # The autouse fixture empties the provider chain: every DOI is unavailable.
    user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/dois",
            json={"dois": ["10.9/one", "10.9/two"]},
            headers=headers,
        )
        listed = await client.get(f"/api/v1/collections/{coll.id}/papers", headers=headers)

    assert [r["status"] for r in response.json()["results"]] == ["unresolved", "unresolved"]
    assert response.json()["unresolved"] == 2
    assert [row["resolved"] for row in listed.json()] == [False, False]
    assert await _count(db, UserLibraryVersion, user_id=user.id) == 2


@pytest.mark.asyncio
async def test_doi_cached_as_an_s2_alias_needs_no_provider(db, monkeypatch):
    async def unexpected(value, **_kwargs):
        raise AssertionError(f"unexpected provider call for {value}")

    s2_id = "b" * 40
    snapshot = _paper(f"s2:{s2_id}", "group:s2import", "Snapshot")
    snapshot.semantic_scholar_id = s2_id
    enriched = _paper("doi:10.1/s2alias", "group:s2import", "Snapshot")
    enriched.semantic_scholar_id = s2_id
    await cache_papers(db, [snapshot])
    await cache_papers(db, [enriched])
    monkeypatch.setattr("app.providers.registry.resolve_dois", unexpected)
    monkeypatch.setattr("app.providers.registry.resolve_id", unexpected)
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        first = await client.post(
            f"/api/v1/collections/{coll.id}/import/dois",
            json={"dois": ["10.1/s2alias"]},
            headers=headers,
        )
        again = await client.post(
            f"/api/v1/collections/{coll.id}/import/dois",
            json={"dois": ["https://doi.org/10.1/S2ALIAS"]},
            headers=headers,
        )

    assert [(r["status"], r["canonical_key"]) for r in first.json()["results"]] == [
        ("added", f"s2:{s2_id}")
    ]
    assert [(r["status"], r["canonical_key"]) for r in again.json()["results"]] == [
        ("duplicate", f"s2:{s2_id}")
    ]
    assert await _count(db, CollectionPaper, collection_id=coll.id) == 1


@pytest.mark.asyncio
async def test_resolution_budget_marks_unfinished_lines_unresolved(db, monkeypatch):
    import asyncio

    from app.config import settings
    from app.providers import registry

    class Slow:
        name = "slow"

        async def lookup_by_doi(self, doi):
            if doi == "10.1/slow":
                await asyncio.sleep(5)
            return _paper(f"doi:{doi}", f"group:{doi}", doi)

    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", [Slow()])
    monkeypatch.setattr(settings, "import_request_budget_seconds", 0.2)
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/dois",
            json={"dois": ["10.1/fast", "10.1/slow"]},
            headers=headers,
        )

    assert [r["status"] for r in response.json()["results"]] == ["added", "unresolved"]


@pytest.mark.asyncio
async def test_key_import_uses_the_same_strict_parser(db):
    await cache_papers(db, [_paper("hash:known", "group:known", "Known")])
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/keys",
            json={"keys": ["hash:known", "hash:unknown", "anything goes", "group:abc"]},
            headers=headers,
        )

    assert response.status_code == 200
    assert [r["status"] for r in response.json()["results"]] == [
        "added",
        "not_found",
        "invalid",
        "invalid",
    ]
    assert await _count(db, CollectionPaper, collection_id=coll.id) == 1


@pytest.mark.asyncio
async def test_non_editor_cannot_import(db):
    _owner, coll, _headers = await _setup(db)
    stranger = await _make_user(db, "stranger@example.com")
    headers = await _auth(db, stranger)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/dois",
            json={"dois": ["10.1/a"]},
            headers=headers,
        )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_imports_are_rate_limited(db, monkeypatch):
    # Freeze the bucket clock so slow requests cannot refill tokens mid-test.
    monkeypatch.setattr(rate_limit, "time", SimpleNamespace(time=lambda: 1_700_000_000.0))
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        statuses = [
            (
                await client.post(
                    f"/api/v1/collections/{coll.id}/import/dois",
                    json={"dois": ["not-a-doi"]},
                    headers=headers,
                )
            ).status_code
            for _ in range(31)
        ]

    assert statuses[:30] == [200] * 30
    assert statuses[30] == 429


@pytest.mark.asyncio
async def test_no_transaction_or_user_lock_is_held_during_resolution(db, engine, monkeypatch):
    user, coll, headers = await _setup(db)
    observed: dict[str, bool] = {}

    async def resolve(dois: list[str], **_kwargs):
        observed["in_transaction"] = db.in_transaction()
        if ON_POSTGRES:
            async with AsyncSession(engine) as other:
                locked = await other.execute(
                    text("SELECT id FROM users WHERE id = :id FOR UPDATE NOWAIT"),
                    {"id": user.id},
                )
                observed["lock_free"] = locked.first() is not None
                await other.rollback()
        return {doi: await fake_resolve_doi(doi) for doi in dois}

    monkeypatch.setattr("app.providers.registry.resolve_dois", resolve)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/dois",
            json={"dois": ["10.1/a"]},
            headers=headers,
        )

    assert response.json()["added"] == 1
    assert observed["in_transaction"] is False
    if ON_POSTGRES:
        assert observed["lock_free"] is True


@pytest.mark.asyncio
async def test_dois_resolve_in_one_batch_and_only_misses_reach_doi_org(db, monkeypatch, s2_mock):
    import json

    from app.providers import registry

    checked: list[str] = []

    async def handle(doi: str) -> bool:
        checked.append(doi)
        return "zenodo" in doi

    monkeypatch.setattr(registry, "doi_handle_exists", handle)
    found = {
        "paperId": "a" * 40,
        "title": "Found in the batch",
        "authors": [{"name": "Alice Smith"}],
        "year": 2024,
        "externalIds": {"DOI": "10.1/found"},
    }
    s2_mock.responses.append([found, None, None])
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/dois",
            json={"dois": ["10.1/found", "10.1/gone", "10.5281/zenodo.1"]},
            headers=headers,
        )

    assert [(r["status"], r["canonical_key"]) for r in response.json()["results"]] == [
        ("added", "doi:10.1/found"),
        ("not_found", "doi:10.1/gone"),
        ("unresolved", "doi:10.5281/zenodo.1"),
    ]
    assert [call.method for call in s2_mock.calls] == ["POST"]
    assert json.loads(s2_mock.calls[0].content)["ids"] == [
        "DOI:10.1/found",
        "DOI:10.1/gone",
        "DOI:10.5281/zenodo.1",
    ]
    assert sorted(checked) == ["10.1/gone", "10.5281/zenodo.1"]
    assert await _count(db, CollectionPaper, collection_id=coll.id) == 2


@pytest.mark.asyncio
async def test_other_identifiers_resolve_in_one_batch_and_are_never_pending(db, monkeypatch):
    only_s2, titans = "a" * 40, "b" * 40
    cached_only = _paper(f"s2:{only_s2}", "group:only", "Only on Semantic Scholar")
    cached_only.semantic_scholar_id = only_s2
    snapshot = _paper(f"s2:{titans}", "group:titans", "Titans")
    snapshot.semantic_scholar_id = titans
    await cache_papers(db, [cached_only, snapshot])
    enriched = _paper("doi:10.48550/arxiv.2501.00663", "group:other", "Titans")
    enriched.semantic_scholar_id = titans
    enriched.arxiv_id = "2501.00663"
    calls: list[list[str]] = []

    async def papers_by_ids(ids: list[str]) -> list[PaperMetadata | None]:
        calls.append(list(ids))
        return [enriched if key == "arxiv:2501.00663" else None for key in ids]

    async def unexpected(identifier: str) -> DoiLookup:
        raise AssertionError(f"unexpected per-key lookup of {identifier}")

    async def resolve_doi(doi: str) -> DoiLookup:
        return DoiLookup("found", enriched)

    monkeypatch.setattr("app.providers.registry.papers_by_ids", papers_by_ids)
    monkeypatch.setattr("app.providers.registry.resolve_id", unexpected)
    monkeypatch.setattr("app.providers.registry.resolve_dois", _batch(resolve_doi))
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/keys",
            json={
                "keys": [
                    f"s2:{only_s2.upper()}",
                    "arXiv:2501.00663v2",
                    "pmid:404",
                    "pmcid:PMC1",
                    "https://arxiv.org/abs/2501.00663",
                    "10.48550/arXiv.2501.00663",
                ]
            },
            headers=headers,
        )

    body = response.json()
    assert [(r["status"], r["canonical_key"]) for r in body["results"]] == [
        ("added", f"s2:{only_s2}"),
        ("added", f"s2:{titans}"),
        ("not_found", "pmid:404"),
        ("not_found", "pmcid:PMC1"),
        ("duplicate", "arxiv:2501.00663"),
        ("duplicate", f"s2:{titans}"),
    ]
    assert (body["added"], body["duplicate"], body["not_found"], body["total"]) == (2, 2, 2, 6)
    # One batch call for every uncached non-DOI line, never one call per line.
    assert calls == [["arxiv:2501.00663", "pmid:404", "pmcid:PMC1"]]
    assert await _count(db, CollectionPaper, collection_id=coll.id) == 2


@pytest.mark.asyncio
async def test_a_failed_batch_leaves_other_identifiers_unavailable(db, s2_mock):
    import json

    import httpx

    s2_mock.handler = lambda _request: httpx.Response(503)
    _user, coll, headers = await _setup(db)
    keys = [f"s2:{'c' * 40}", "arxiv:2501.00663", "pmid:31452104", "pmcid:PMC2323736"]

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/keys", json={"keys": keys}, headers=headers
        )

    assert [(r["status"], r["canonical_key"]) for r in response.json()["results"]] == [
        ("unavailable", key) for key in keys
    ]
    # Only the batch endpoint was called (with the provider's own retries).
    assert {(call.method, call.url.path) for call in s2_mock.calls} == {
        ("POST", "/graph/v1/paper/batch")
    }
    assert json.loads(s2_mock.calls[0].content)["ids"] == [
        "c" * 40,
        "ARXIV:2501.00663",
        "PMID:31452104",
        "PMCID:2323736",
    ]
    assert await _count(db, CollectionPaper, collection_id=coll.id) == 0


@pytest.mark.asyncio
async def test_an_unreadable_batch_falls_back_to_one_lookup_per_key(db, monkeypatch):
    from app.providers.semantic_scholar import ProviderError

    found = _paper(f"s2:{'e' * 40}", "group:bypmid", "Found by PMID")
    found.semantic_scholar_id = "e" * 40
    found.pmid = "1"
    calls: list[str] = []

    async def papers_by_ids(_ids: list[str]):
        raise ProviderError("invalid_query", "Unreadable batch.", 422)

    async def resolve_id(identifier: str) -> DoiLookup:
        calls.append(identifier)
        return DoiLookup("found", found) if identifier == "pmid:1" else DoiLookup("not_found")

    monkeypatch.setattr("app.providers.registry.papers_by_ids", papers_by_ids)
    monkeypatch.setattr("app.providers.registry.resolve_id", resolve_id)
    _user, coll, headers = await _setup(db)

    async with _client(db) as client:
        response = await client.post(
            f"/api/v1/collections/{coll.id}/import/keys",
            json={"keys": ["pmid:1", "pmid:2"]},
            headers=headers,
        )

    assert [(r["status"], r["canonical_key"]) for r in response.json()["results"]] == [
        ("added", f"s2:{'e' * 40}"),
        ("not_found", "pmid:2"),
    ]
    assert calls == ["pmid:1", "pmid:2"]
