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


@pytest.mark.asyncio
async def test_collection_papers_carry_the_callers_states_and_tags(db):
    from app.collections.sharing import read_link
    from app.papers import service as paper_service

    owner = await _make_user(db, "annotated-owner@example.com")
    reader = await _make_user(db, "annotated-reader@example.com")
    coll = await collections_service.create_collection(db, owner.id, CollectionCreate(name="Ann"))
    await cache_papers(
        db,
        [
            _paper("doi:10.3/v1", "group:ann", "Version One"),
            _paper("doi:10.3/v2", "group:ann", "Version Two"),
            _paper("doi:10.3/other", "group:other", "Other Paper"),
        ],
    )
    await collections_service.add_paper(db, coll.id, owner.id, "doi:10.3/v2")
    await collections_service.add_paper(db, coll.id, owner.id, "doi:10.3/other")
    await collections_service.add_paper(db, coll.id, owner.id, "doi:10.9/pending")
    # A tag on a sibling version is shared by the group; states are per key.
    await paper_service.add_tag(db, owner.id, "doi:10.3/v1", "seminal")
    await paper_service.add_tag(db, owner.id, "doi:10.9/pending", "todo")
    await paper_service.set_paper_state(db, owner.id, "doi:10.3/v2", "reading")
    await paper_service.set_paper_state(db, owner.id, "doi:10.3/v1", "read")
    await paper_service.add_tag(db, reader.id, "doi:10.3/other", "mine")

    rows = {
        r["paper_canonical_key"]: r
        for r in await collections_service.list_papers(db, coll.id, owner.id, with_annotations=True)
    }

    assert [t.tag for t in rows["doi:10.3/v2"]["my_tags"]] == ["seminal"]
    assert [(s.paper_canonical_key, s.state) for s in rows["doi:10.3/v2"]["my_states"]] == [
        ("doi:10.3/v2", "reading")
    ]
    assert rows["doi:10.3/other"]["my_tags"] == []
    assert rows["doi:10.3/other"]["my_states"] == []
    assert [t.tag for t in rows["doi:10.9/pending"]["my_tags"]] == ["todo"]
    # Each row matches the per-paper endpoints exactly.
    for key, row in rows.items():
        assert row["my_tags"] == await paper_service.get_tags(db, owner.id, key)
        assert row["my_states"] == await paper_service.get_paper_states(db, owner.id, key)

    # A signed-in read-link reader gets their own annotations, never the owner's.
    token = (await read_link(db, coll.id, owner.id, "enable"))["url"].split("#share=")[1]
    reader_rows = {
        r["paper_canonical_key"]: r
        for r in await collections_service.list_papers(
            db, coll.id, reader.id, token, with_annotations=True
        )
    }
    assert [t.tag for t in reader_rows["doi:10.3/other"]["my_tags"]] == ["mine"]
    assert reader_rows["doi:10.3/v2"]["my_tags"] == []
    assert reader_rows["doi:10.3/v2"]["my_states"] == []

    # An anonymous reader has no annotations at all.
    anonymous_rows = await collections_service.list_papers(
        db, coll.id, None, token, with_annotations=True
    )
    assert all("my_states" not in r and "my_tags" not in r for r in anonymous_rows)


@pytest.mark.asyncio
async def test_batched_tags_match_per_key_lookups(db):
    from app.papers import service as paper_service

    user = await _make_user(db, "batched-tags@example.com")
    await cache_papers(
        db,
        [
            _paper("doi:10.4/a1", "group:a", "A one"),
            _paper("doi:10.4/a2", "group:a", "A two"),
            _paper("doi:10.4/b", "group:b", "B"),
        ],
    )
    await paper_service.add_tag(db, user.id, "doi:10.4/a1", "first")
    await paper_service.add_tag(db, user.id, "doi:10.4/a2", "second")
    await paper_service.add_tag(db, user.id, "doi:10.4/b", "bee")
    await paper_service.add_tag(db, user.id, "hash:uncached", "loose")
    keys = ["doi:10.4/a1", "doi:10.4/a2", "doi:10.4/b", "hash:uncached", "hash:none"]

    batched = await paper_service.get_tags_batch(db, user.id, keys)

    assert list(batched) == keys
    for key in keys:
        assert batched[key] == await paper_service.get_tags(db, user.id, key)
    assert [t.tag for t in batched["doi:10.4/a2"]] == ["first", "second"]
    assert batched["hash:none"] == []
    assert await paper_service.get_tags_batch(db, user.id, []) == {}
    assert await paper_service.get_paper_states_batch(db, user.id, []) == {}


@pytest.mark.asyncio
async def test_only_the_list_endpoint_loads_annotations(db, monkeypatch):
    from app.dependencies import get_optional_user
    from app.papers import service as paper_service

    owner = await _make_user(db, "annotations-scope@example.com")
    coll = await collections_service.create_collection(db, owner.id, CollectionCreate(name="Scope"))
    await cache_papers(db, [_paper("doi:10.5/a", "group:scope", "Scoped Paper")])
    await collections_service.add_paper(db, coll.id, owner.id, "doi:10.5/a")
    await paper_service.set_paper_state(db, owner.id, "doi:10.5/a", "read")

    calls: list[str] = []
    real_states = collections_service.get_paper_states_batch
    real_tags = collections_service.get_tags_batch

    async def states_spy(*args, **kwargs):
        calls.append("states")
        return await real_states(*args, **kwargs)

    async def tags_spy(*args, **kwargs):
        calls.append("tags")
        return await real_tags(*args, **kwargs)

    monkeypatch.setattr(collections_service, "get_paper_states_batch", states_spy)
    monkeypatch.setattr(collections_service, "get_tags_batch", tags_spy)

    # Graph seeds and Zotero sync discard the annotations: no extra queries.
    rows = await collections_service.list_papers(db, coll.id, owner.id)
    assert calls == []
    assert all("my_states" not in r and "my_tags" not in r for r in rows)

    async def override_db():
        yield db

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_optional_user] = lambda: owner
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get(f"/api/v1/collections/{coll.id}/papers")

    assert response.status_code == 200
    assert calls == ["states", "tags"]
    row = response.json()[0]
    assert [s["state"] for s in row["my_states"]] == ["read"]
    assert row["my_tags"] == []
