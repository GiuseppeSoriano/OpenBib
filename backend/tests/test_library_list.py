"""GET /library/entries filters, sorting and paging, and GET /library/facets."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient

from app.auth.service import create_access_token, create_session, hash_password, utcnow
from app.collections.models import Collection, CollectionMember, CollectionPaper
from app.dependencies import get_db
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.main import create_app
from app.papers.models import CachedPaperMetadata, UserPaperState, UserPaperTag
from app.users.models import User

pytestmark = pytest.mark.asyncio

ENTRIES = "/api/v1/library/entries"
FACETS = "/api/v1/library/facets"
T0 = datetime(2025, 1, 1, 12, 0, 0)


async def _user(db, email: str = "reader@example.com") -> tuple[uuid.UUID, dict[str, str]]:
    user = User(
        id=uuid.uuid4(),
        email=email,
        password_hash=hash_password("password123"),
        display_name="Reader",
        email_verified_at=utcnow(),
        terms_version="dev-1",
        privacy_version="dev-1",
    )
    db.add(user)
    await db.flush()
    session, _ = await create_session(db, user.id)
    return user.id, {"Authorization": f"Bearer {create_access_token(user.id, session.id)}"}


async def _entry(
    db,
    user_id: uuid.UUID,
    n: int,
    *,
    cached: bool = True,
    title: str | None = None,
    venue: str | None = None,
    authors: list[dict] | None = None,
    year: int | None = 2020,
    cited: int | None = None,
    group: str | None = None,
) -> str:
    """Entry ``n`` (added ``n`` minutes after T0) pinning ``doi:10.1/p{n}``."""
    key = f"doi:10.1/p{n}"
    group = group or f"group:p{n:03d}"
    if cached and await db.get(CachedPaperMetadata, key) is None:
        db.add(
            CachedPaperMetadata(
                canonical_key=key,
                paper_group_key=group,
                title=title or f"Paper {n}",
                authors_json=authors if authors is not None else [{"name": "Alice Smith"}],
                topics_json=[],
                keywords_json=[],
                publication_date=date(year, 1, 1) if year else None,
                venue=venue,
                cited_by_count=cited,
                provider_source="openalex",
            )
        )
    db.add(
        UserLibraryEntry(
            user_id=user_id,
            paper_group_key=group,
            primary_canonical_key=key,
            created_at=T0 + timedelta(minutes=n),
        )
    )
    await db.flush()
    db.add(UserLibraryVersion(user_id=user_id, paper_canonical_key=key, paper_group_key=group))
    await db.flush()
    return group


def _client(db) -> AsyncClient:
    async def override_db():
        yield db

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")


async def _groups(client, headers, **params) -> list[str]:
    response = await client.get(ENTRIES, params=params, headers=headers)
    assert response.status_code == 200, response.text
    return [item["paper_group_key"] for item in response.json()["items"]]


async def test_envelope_pages_beyond_one_hundred_with_the_full_total(db):
    user_id, headers = await _user(db)
    other_id, _ = await _user(db, "other@example.com")
    for n in range(105):
        await _entry(db, user_id, n)
    await _entry(db, other_id, 500)

    async with _client(db) as client:
        first = await client.get(ENTRIES, params={"size": 100}, headers=headers)
        second = await client.get(ENTRIES, params={"size": 100, "page": 2}, headers=headers)
        default = await client.get(ENTRIES, headers=headers)
        too_big = await client.get(ENTRIES, params={"size": 101}, headers=headers)

    assert first.status_code == 200
    body = first.json()
    assert (body["total"], body["page"], body["size"]) == (105, 1, 100)
    assert len(body["items"]) == 100
    # Newest first.
    assert body["items"][0]["paper_group_key"] == "group:p104"
    assert [i["paper_group_key"] for i in second.json()["items"]] == [
        f"group:p{n:03d}" for n in (4, 3, 2, 1, 0)
    ]
    assert second.json()["total"] == 105
    assert (default.json()["size"], len(default.json()["items"])) == (25, 25)
    assert too_big.status_code == 422
    all_groups = {i["paper_group_key"] for i in body["items"] + second.json()["items"]}
    assert "group:p500" not in all_groups
    assert len(all_groups) == 105


async def test_resolved_reflects_primary_metadata(db):
    user_id, headers = await _user(db)
    await _entry(db, user_id, 1)
    await _entry(db, user_id, 2, cached=False)

    async with _client(db) as client:
        response = await client.get(ENTRIES, headers=headers)

    items = {i["paper_group_key"]: i for i in response.json()["items"]}
    assert items["group:p001"]["resolved"] is True
    assert items["group:p001"]["primary_version"]["title"] == "Paper 1"
    assert items["group:p002"]["resolved"] is False
    assert items["group:p002"]["primary_version"] is None


async def test_q_matches_title_and_venue_with_like_wildcards_escaped(db):
    user_id, headers = await _user(db)
    await _entry(db, user_id, 1, title="Graph neural networks")
    await _entry(db, user_id, 2, title="Kernels", venue="Neural Computation")
    await _entry(db, user_id, 3, title="100% recall with snake_case tokens")
    await _entry(db, user_id, 4, title="1000 recall with snakeXcase tokens")
    await _entry(db, user_id, 5, title="Back\\slash")
    await _entry(db, user_id, 6, cached=False)

    async with _client(db) as client:
        neural = await _groups(client, headers, q="  NEURAL ")
        percent = await _groups(client, headers, q="100%")
        underscore = await _groups(client, headers, q="snake_case")
        backslash = await _groups(client, headers, q="k\\s")
        nothing = await _groups(client, headers, q="zzz")
        blank = await _groups(client, headers, q="   ")
        too_long = await client.get(ENTRIES, params={"q": "x" * 201}, headers=headers)

    assert sorted(neural) == ["group:p001", "group:p002"]
    assert percent == ["group:p003"]
    assert underscore == ["group:p003"]
    assert backslash == ["group:p005"]
    assert nothing == []
    assert len(blank) == 6
    assert too_long.status_code == 422


async def test_q_matches_decoded_author_names_only(db):
    user_id, headers = await _user(db)
    await _entry(db, user_id, 1, authors=[{"name": "Anna Müller", "orcid": None}])
    await _entry(db, user_id, 2, authors=[{"name": "Bob Stone", "affiliations": ["MIT"]}])
    await _entry(db, user_id, 3, authors=[{"name": "Nameless Author"}, {"name": "Carol"}])
    await _entry(db, user_id, 4, authors=[])

    async with _client(db) as client:
        mueller = await _groups(client, headers, q="Müller")
        lower_mueller = await _groups(client, headers, q="müller")
        name = await _groups(client, headers, q="name")
        carol = await _groups(client, headers, q="carol")
        key_names = await _groups(client, headers, q="orcid")
        escaped = await _groups(client, headers, q="u00fc")

    assert mueller == ["group:p001"]
    assert lower_mueller == ["group:p001"]
    # Only the author actually called "Name…", not every row's "name" key.
    assert name == ["group:p003"]
    assert carol == ["group:p003"]
    assert key_names == []
    assert escaped == []


async def test_state_filter_matches_any_pinned_version(db):
    user_id, headers = await _user(db)
    other_id, _ = await _user(db, "other@example.com")
    await _entry(db, user_id, 1)
    await _entry(db, user_id, 2)
    await _entry(db, user_id, 3)
    # A second pinned version of entry 1 carries the state.
    db.add(
        UserLibraryVersion(
            user_id=user_id, paper_canonical_key="doi:10.1/v2", paper_group_key="group:p001"
        )
    )
    db.add(UserPaperState(user_id=user_id, paper_canonical_key="doi:10.1/v2", state="reading"))
    db.add(UserPaperState(user_id=user_id, paper_canonical_key="doi:10.1/p2", state="read"))
    # Another user's state on a paper this user saved does not count.
    db.add(UserPaperState(user_id=other_id, paper_canonical_key="doi:10.1/p3", state="reading"))
    # A state on a paper that is not pinned does not count either.
    db.add(UserPaperState(user_id=user_id, paper_canonical_key="doi:10.1/free", state="reading"))
    await db.flush()

    async with _client(db) as client:
        reading = await _groups(client, headers, state="reading")
        read = await _groups(client, headers, state="read")
        unseen = await _groups(client, headers, state="unseen")
        invalid = await client.get(ENTRIES, params={"state": "bogus"}, headers=headers)

    assert reading == ["group:p001"]
    assert read == ["group:p002"]
    assert unseen == []
    assert invalid.status_code == 422


async def test_tag_filter_uses_the_entry_group(db):
    user_id, headers = await _user(db)
    other_id, _ = await _user(db, "other@example.com")
    await _entry(db, user_id, 1)
    await _entry(db, user_id, 2)
    await _entry(db, user_id, 3)
    db.add(
        UserPaperTag(
            user_id=user_id,
            paper_canonical_key="doi:10.1/p1",
            tag="ml",
            paper_group_key="group:p001",
        )
    )
    db.add(
        UserPaperTag(
            user_id=user_id,
            paper_canonical_key="doi:10.1/p2",
            tag="ML",
            paper_group_key="group:p002",
        )
    )
    db.add(
        UserPaperTag(
            user_id=other_id,
            paper_canonical_key="doi:10.1/p3",
            tag="ml",
            paper_group_key="group:p003",
        )
    )
    await db.flush()

    async with _client(db) as client:
        ml = await _groups(client, headers, tag="ml")
        combined = await _groups(client, headers, tag="ml", q="paper 2")
        empty = await client.get(ENTRIES, params={"tag": ""}, headers=headers)

    assert ml == ["group:p001"]
    assert combined == []
    assert empty.status_code == 422


async def _collection(
    db, owner_id, *, members=(), keys=(), read_link_digest: str | None = None
) -> uuid.UUID:
    coll = Collection(
        id=uuid.uuid4(), owner_id=owner_id, name="Reading", read_link_digest=read_link_digest
    )
    db.add(coll)
    await db.flush()
    db.add(CollectionMember(collection_id=coll.id, user_id=owner_id, role="owner"))
    for member_id, role in members:
        db.add(CollectionMember(collection_id=coll.id, user_id=member_id, role=role))
    for position, key in enumerate(keys):
        db.add(CollectionPaper(collection_id=coll.id, paper_canonical_key=key, position=position))
    await db.flush()
    return coll.id


async def test_collection_filter_requires_a_viewable_collection(db):
    user_id, headers = await _user(db)
    owner_id, _ = await _user(db, "owner@example.com")
    for n in (1, 2, 3):
        await _entry(db, user_id, n)
    db.add(
        UserLibraryVersion(
            user_id=user_id, paper_canonical_key="doi:10.1/v3", paper_group_key="group:p003"
        )
    )
    await db.flush()
    mine = await _collection(db, user_id, keys=["doi:10.1/p1", "doi:10.1/elsewhere"])
    shared = await _collection(db, owner_id, members=[(user_id, "viewer")], keys=["doi:10.1/v3"])
    # A read link is a capability for the shared page only, never for this filter.
    linked = await _collection(db, owner_id, read_link_digest="0" * 64, keys=["doi:10.1/p2"])
    private = await _collection(db, owner_id, keys=["doi:10.1/p1"])

    async with _client(db) as client:
        in_mine = await _groups(client, headers, collection_id=str(mine))
        in_shared = await _groups(client, headers, collection_id=str(shared))
        link_only = await client.get(
            ENTRIES, params={"collection_id": str(linked)}, headers=headers
        )
        hidden = await client.get(ENTRIES, params={"collection_id": str(private)}, headers=headers)
        missing = await client.get(
            ENTRIES, params={"collection_id": str(uuid.uuid4())}, headers=headers
        )
        malformed = await client.get(ENTRIES, params={"collection_id": "nope"}, headers=headers)

    assert in_mine == ["group:p001"]
    # Matched through a second pinned version of the entry.
    assert in_shared == ["group:p003"]
    assert link_only.status_code == 404
    assert hidden.status_code == 404
    assert missing.status_code == 404
    assert malformed.status_code == 422


async def test_sorts_put_nulls_last_and_break_ties_on_the_group_key(db):
    user_id, headers = await _user(db)
    await _entry(db, user_id, 1, title="beta", year=2019, cited=5)
    await _entry(db, user_id, 2, title="Alpha", year=None, cited=None)
    await _entry(db, user_id, 3, title="gamma", year=2023, cited=5)
    await _entry(db, user_id, 4, cached=False)
    await _entry(db, user_id, 5, title="alpha", year=2023, cited=40)

    async with _client(db) as client:
        added = await _groups(client, headers)
        by_title = await _groups(client, headers, sort="title")
        by_year = await _groups(client, headers, sort="year")
        by_citations = await _groups(client, headers, sort="citations")
        invalid = await client.get(ENTRIES, params={"sort": "random"}, headers=headers)

    assert added == ["group:p005", "group:p004", "group:p003", "group:p002", "group:p001"]
    assert by_title == ["group:p002", "group:p005", "group:p001", "group:p003", "group:p004"]
    assert by_year == ["group:p003", "group:p005", "group:p001", "group:p002", "group:p004"]
    assert by_citations == ["group:p005", "group:p001", "group:p003", "group:p002", "group:p004"]
    assert invalid.status_code == 422


async def test_sort_applies_before_paging(db):
    user_id, headers = await _user(db)
    for n in range(30):
        await _entry(db, user_id, n, cited=n)

    async with _client(db) as client:
        first = await _groups(client, headers, sort="citations", size=10)
        third = await _groups(client, headers, sort="citations", size=10, page=3)
        past_end = await client.get(ENTRIES, params={"page": 9}, headers=headers)

    assert first[0] == "group:p029"
    assert third[-1] == "group:p000"
    assert past_end.json() == {"items": [], "total": 30, "page": 9, "size": 25}


async def test_facets_count_entries_per_tag_and_state(db):
    user_id, headers = await _user(db)
    other_id, _ = await _user(db, "other@example.com")
    for n in (1, 2, 3):
        await _entry(db, user_id, n)
    await _entry(db, user_id, 4, cached=False)
    await _entry(db, other_id, 9, cached=False)
    db.add(
        UserLibraryVersion(
            user_id=user_id, paper_canonical_key="doi:10.1/v1", paper_group_key="group:p001"
        )
    )
    for key, group, tag in [
        ("doi:10.1/p1", "group:p001", "ml"),
        ("doi:10.1/v1", "group:p001", "ml"),
        ("doi:10.1/p2", "group:p002", "ml"),
        ("doi:10.1/p2", "group:p002", "Bio"),
        ("doi:10.1/free", None, "orphan"),
    ]:
        db.add(
            UserPaperTag(user_id=user_id, paper_canonical_key=key, tag=tag, paper_group_key=group)
        )
    db.add(UserPaperTag(user_id=other_id, paper_canonical_key="doi:10.1/p9", tag="ml"))
    for key, state in [
        ("doi:10.1/p1", "reading"),
        ("doi:10.1/v1", "reading"),
        ("doi:10.1/p2", "read"),
        ("doi:10.1/p3", "reading"),
        ("doi:10.1/free", "important"),
    ]:
        db.add(UserPaperState(user_id=user_id, paper_canonical_key=key, state=state))
    db.add(UserPaperState(user_id=other_id, paper_canonical_key="doi:10.1/p9", state="read"))
    await db.flush()

    async with _client(db) as client:
        response = await client.get(FACETS, headers=headers)
        by_tag = await client.get(ENTRIES, params={"tag": "ml"}, headers=headers)
        by_state = await client.get(ENTRIES, params={"state": "reading"}, headers=headers)

    assert response.status_code == 200
    assert response.json() == {
        "tags": [{"tag": "Bio", "count": 1}, {"tag": "ml", "count": 2}],
        "states": [{"state": "reading", "count": 2}, {"state": "read", "count": 1}],
        "total": 4,
        "unresolved": 1,
    }
    # Facet counts agree with the filtered totals.
    assert by_tag.json()["total"] == 2
    assert by_state.json()["total"] == 2


async def test_list_and_facets_require_auth(db):
    async with _client(db) as client:
        entries = await client.get(ENTRIES)
        facets = await client.get(FACETS)

    assert entries.status_code == 401
    assert facets.status_code == 401
