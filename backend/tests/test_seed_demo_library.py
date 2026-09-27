"""scripts.seed_demo_library: dev-only seed data for the regression pass."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

from sqlalchemy import func, select

from app.collections.models import Collection, CollectionPaper
from app.common.key_repair import repair_paper_keys
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.notes.models import Note
from app.papers.models import CachedPaperMetadata, UserPaperState, UserPaperTag
from app.users.models import User
from scripts import seed_demo_library as seed

TNN = "doi:10.1109/tnn.2008.2005605"


async def _user(db) -> User:
    user = User(id=uuid.uuid4(), email="seed@example.com", password_hash="x", display_name="Seed")
    db.add(user)
    await db.flush()
    return user


async def _count(db, column, **filters) -> int:
    stmt = select(func.count()).select_from(column.class_)
    for name, value in filters.items():
        stmt = stmt.where(getattr(column.class_, name) == value)
    return (await db.execute(stmt)).scalar_one()


async def test_seeds_papers_and_long_data_idempotently_and_resets_them(db):
    user = await _user(db)

    papers = await seed.seed_papers(db, user, 30, 3)
    long_data = await seed.seed_long_data(db, user)
    again = await seed.seed_papers(db, user, 30, 3)

    assert papers["library_versions"] == 30
    assert papers["collections"] == 3
    assert again["library_versions"] == again["collection_papers"] == 0
    assert long_data["collections"] == 1
    names = (
        await db.execute(select(Collection.name).where(Collection.owner_id == user.id))
    ).scalars()
    assert max(len(name) for name in names) == 200
    long_title = await db.get(CachedPaperMetadata, f"{seed.DEMO_PREFIX}long-title")
    assert len(long_title.title) == 300
    assert max(len(token) for token in long_title.title.split()) == 180
    many = await db.get(CachedPaperMetadata, f"{seed.DEMO_PREFIX}many-authors")
    assert len(many.authors_json) == 60
    assert await db.get(CachedPaperMetadata, seed.UNRESOLVED_LONG_KEY) is None
    assert 190 <= len(seed.UNRESOLVED_LONG_KEY.removeprefix("doi:")) <= 200
    note = (
        await db.execute(
            select(Note.content).where(Note.target_key == f"{seed.DEMO_PREFIX}long-title")
        )
    ).scalar_one()
    assert len(note) == 5000
    published = await db.get(CachedPaperMetadata, f"{seed.DEMO_PREFIX}versions.published")
    assert (
        await _count(
            db, UserLibraryVersion.paper_canonical_key, paper_group_key=published.paper_group_key
        )
        == 3
    )

    removed = await seed.reset_demo_data(db, user)

    assert removed["collections"] == 4
    assert await _count(db, UserLibraryVersion.paper_canonical_key, user_id=user.id) == 0
    assert await _count(db, UserLibraryEntry.paper_group_key, user_id=user.id) == 0
    assert await _count(db, UserPaperTag.tag, user_id=user.id) == 0
    assert await _count(db, CollectionPaper.paper_canonical_key) == 0


async def test_legacy_shapes_are_the_ones_the_repair_merges(db):
    user = await _user(db)
    user_id = user.id

    await seed.seed_legacy_raw_doi(db, user)
    report = await db.run_sync(lambda session: repair_paper_keys(session.connection()))
    db.expire_all()

    assert report.mapped == 3
    assert report.unrepairable == ["doi:not-a-doi"]
    keys = (await db.execute(select(CollectionPaper.paper_canonical_key))).scalars().all()
    assert sorted(keys) == ["doi:10.1000/xyz123", TNN, "doi:not-a-doi"]
    assert (
        await db.execute(select(UserPaperState.state).where(UserPaperState.user_id == user_id))
    ).scalars().all() == ["reading"]
    assert await _count(db, UserPaperTag.tag, user_id=user_id) == 1
    assert await _count(db, UserLibraryEntry.paper_group_key, user_id=user_id) == 3


def test_refuses_to_run_in_production(monkeypatch):
    monkeypatch.setattr(seed, "settings", SimpleNamespace(environment="production"))

    assert seed.main(["--email", "seed@example.com", "--papers", "1"]) == 2
