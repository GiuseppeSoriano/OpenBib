"""Hydrated collection paper rows (metadata joined from the snapshot)."""

import uuid
from datetime import date

import pytest
from httpx import ASGITransport, AsyncClient

from app.auth.service import hash_password
from app.collections import service as collections_service
from app.collections.schemas import CollectionCreate
from app.dependencies import get_db
from app.main import create_app
from app.papers.service import cache_papers
from app.providers.base import Author, PaperMetadata
from app.users.models import User


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
        authors=[Author(name="Alice Smith")],
        publication_date=date(2024, 1, 1),
        venue="Journal of Tests",
        cited_by_count=5,
        provider_source="openalex",
    )


@pytest.mark.asyncio
async def test_collection_papers_return_full_metadata(db):
    user = await _make_user(db, "hydrated@example.com")
    coll = await collections_service.create_collection(
        db, user.id, CollectionCreate(name="ML Papers")
    )
    await cache_papers(db, [_paper("doi:10.1/hyd", "group:hyd", "Hydrated Paper")])
    await collections_service.add_paper(db, coll.id, user.id, "doi:10.1/hyd")

    rows = await collections_service.list_papers(db, coll.id, user.id)

    assert len(rows) == 1
    row = rows[0]
    assert row["paper_canonical_key"] == "doi:10.1/hyd"
    assert row["paper_group_key"] == "group:hyd"
    assert row["paper"] is not None
    assert row["paper"].title == "Hydrated Paper"
    assert row["paper"].venue == "Journal of Tests"
    assert row["paper"].cited_by_count == 5


@pytest.mark.asyncio
async def test_collection_papers_degrade_without_cached_metadata(db):
    user = await _make_user(db, "degraded@example.com")
    coll = await collections_service.create_collection(db, user.id, CollectionCreate(name="Sparse"))
    await collections_service.add_paper(db, coll.id, user.id, "doi:10.9/nocache")

    rows = await collections_service.list_papers(db, coll.id, user.id)

    assert len(rows) == 1
    assert rows[0]["paper"] is None
    assert rows[0]["paper_group_key"] is None
    assert rows[0]["paper_canonical_key"] == "doi:10.9/nocache"


@pytest.mark.asyncio
async def test_public_collection_papers_readable_anonymously_with_metadata(db):
    user = await _make_user(db, "publicowner@example.com")
    coll = await collections_service.create_collection(
        db, user.id, CollectionCreate(name="Public Reads")
    )
    await cache_papers(db, [_paper("doi:10.2/pub", "group:pub", "Public Paper")])
    await collections_service.add_paper(db, coll.id, user.id, "doi:10.2/pub")

    async def override_db():
        yield db

    app = create_app()
    app.dependency_overrides[get_db] = override_db

    from app.collections.sharing import read_link

    token = (await read_link(db, coll.id, user.id, "enable"))["url"].split("#share=")[1]
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get(
            f"/api/v1/collections/{coll.id}/papers", headers={"X-Collection-Share-Token": token}
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload[0]["paper"]["title"] == "Public Paper"
