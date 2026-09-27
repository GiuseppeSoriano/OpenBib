"""HTTP contract of POST /graph/related and /graph/related/top-up."""

import json
import os
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import create_access_token, create_session, hash_password, utcnow
from app.dependencies import get_db
from app.main import create_app
from app.papers.models import CachedPaperMetadata
from app.providers import registry
from app.providers.openalex import RelatedPage
from app.users.models import User

# SQLite ignores FOR UPDATE, so only Postgres can prove the user lock is free.
ON_POSTGRES = os.getenv("TEST_DB_URL", "").startswith("postgresql")
SEED = "doi:10.1/seed"
SEED_GROUP = "group:seed"


def _entry(n: int) -> list:
    return [f"Wp{n}", f"doi:10.1/p{n}", f"group:p{n}", f"Paper {n}", 1000 - n, "2020-01-01"]


class FakeOpenAlex:
    def __init__(self, total: int = 100):
        self.total = total
        self.fail: set[str] = set()
        self.calls = 0
        self.observe = None

    async def related_page(self, openalex_id, *, cursor="*", per_page=200, **_kwargs):
        self.calls += 1
        if self.observe:
            await self.observe()
        if openalex_id.rsplit("/", 1)[-1] in self.fail:
            raise RuntimeError("provider down")
        start = 0 if cursor == "*" else int(cursor)
        stop = min(start + per_page, self.total)
        entries = [_entry(i) for i in range(start, stop)]
        return RelatedPage(entries, self.total, str(stop) if stop < self.total else None)

    async def works_by_ids(self, ids):
        if self.observe:
            await self.observe()
        return []


@pytest.fixture
def fake(monkeypatch):
    fake = FakeOpenAlex()
    monkeypatch.setattr(registry, "related_page", fake.related_page)
    monkeypatch.setattr(registry, "works_by_ids", fake.works_by_ids)
    return fake


@pytest.fixture
async def seeds(db):
    for key, group, work in ((SEED, SEED_GROUP, "W0"), ("doi:10.1/seed2", "group:seed2", "W1")):
        db.add(
            CachedPaperMetadata(
                canonical_key=key,
                paper_group_key=group,
                title="Seed",
                authors_json=[],
                topics_json=[],
                keywords_json=[],
                openalex_id=f"https://openalex.org/{work}",
                provider_source="openalex",
            )
        )
    await db.flush()


async def _make_user(db) -> User:
    user = User(
        id=uuid.uuid4(),
        email=f"{uuid.uuid4().hex[:8]}@example.com",
        password_hash=hash_password("password123"),
        display_name="Grapher",
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


def _range_body(**extra) -> dict:
    return {"source_key": SEED, "source_group_key": SEED_GROUP, **extra}


def _top_up_body(*sources, **extra) -> dict:
    return {
        "sources": list(sources)
        or [{"source_key": SEED, "source_group_key": SEED_GROUP, "connected_group_keys": []}],
        **extra,
    }


async def test_related_is_public_and_skips_saved_keys(db, fake, seeds, monkeypatch):
    async def fail_saved(*_args):
        raise AssertionError("anonymous requests must not read saved keys")

    monkeypatch.setattr("app.graph.service.saved_canonical_keys", fail_saved)

    async with _client(db) as client:
        response = await client.post("/api/v1/graph/related", json=_range_body())

    assert response.status_code == 200
    body = response.json()
    assert body["group_keys"] == [f"group:p{i}" for i in range(30)]
    assert (body["range_size"], body["max_results"]) == (30, 10_000)
    assert body["snapshot_id"] and body["reason"] is None
    assert response.headers["X-RateLimit-Limit"] == "20"


async def test_related_uses_saved_keys_when_authenticated(db, fake, seeds, monkeypatch):
    user = await _make_user(db)
    headers = await _auth(db, user)
    seen: list[str] = []

    async def saved(_db, user_id):
        seen.append(str(user_id))
        return {SEED, "doi:10.1/p0"}

    monkeypatch.setattr("app.graph.service.saved_canonical_keys", saved)

    async with _client(db) as client:
        response = await client.post("/api/v1/graph/related", json=_range_body(), headers=headers)

    assert response.status_code == 200
    assert seen == [str(user.id)]
    assert response.headers["X-RateLimit-Limit"] == "60"


async def test_related_validation_limits(db, fake, seeds):
    async with _client(db) as client:
        too_many = await client.post(
            "/api/v1/graph/related",
            json=_range_body(exclude_group_keys=[f"group:{i}" for i in range(501)]),
        )
        unaligned = await client.post("/api/v1/graph/related", json=_range_body(range_start=45))
        beyond = await client.post("/api/v1/graph/related", json=_range_body(range_start=50_010))
        long_key = await client.post(
            "/api/v1/graph/related", json=_range_body(source_group_key="g" * 513)
        )
        max_exclusions = await client.post(
            "/api/v1/graph/related",
            json=_range_body(exclude_group_keys=[f"group:{i}" for i in range(500)]),
        )

    assert too_many.status_code == 422
    assert unaligned.status_code == 422
    assert unaligned.json()["detail"]["code"] == "range_start_not_aligned"
    assert unaligned.json()["detail"]["range_size"] == 30
    assert beyond.status_code == 422
    assert long_key.status_code == 422
    assert max_exclusions.status_code == 200


async def test_top_up_validation_limits(db, fake, seeds):
    source = {"source_key": SEED, "source_group_key": SEED_GROUP}
    async with _client(db) as client:
        many_sources = await client.post(
            "/api/v1/graph/related/top-up",
            json=_top_up_body(*[{**source, "connected_group_keys": []}] * 21),
        )
        no_sources = await client.post(
            "/api/v1/graph/related/top-up", json={"sources": [], "target_per_source": 30}
        )
        many_connected = await client.post(
            "/api/v1/graph/related/top-up",
            json=_top_up_body(
                {**source, "connected_group_keys": [f"group:{i}" for i in range(61)]}
            ),
        )
        big_target = await client.post(
            "/api/v1/graph/related/top-up", json=_top_up_body(target_per_source=31)
        )
        too_many_pins = await client.post(
            "/api/v1/graph/related/top-up",
            json=_top_up_body(exclude_group_keys=[f"group:{i}" for i in range(501)]),
        )

    assert many_sources.status_code == 422
    assert no_sources.status_code == 422
    assert many_connected.status_code == 422
    assert big_target.status_code == 422
    assert big_target.json()["detail"]["code"] == "target_per_source_too_large"
    assert too_many_pins.status_code == 422


async def test_provider_failure_is_a_coded_502(db, fake, seeds):
    fake.fail.add("W0")

    async with _client(db) as client:
        response = await client.post("/api/v1/graph/related", json=_range_body())

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "related_provider_unavailable"


async def test_top_up_is_502_only_when_every_source_fails(db, fake, seeds):
    two = (
        {"source_key": SEED, "source_group_key": SEED_GROUP, "connected_group_keys": []},
        {"source_key": "doi:10.1/seed2", "source_group_key": "group:seed2"},
    )
    fake.fail.add("W1")
    async with _client(db) as client:
        partial = await client.post("/api/v1/graph/related/top-up", json=_top_up_body(*two))
        fake.fail.add("W0")
        # Another ordering, so W0's stored snapshot cannot answer.
        failed = await client.post(
            "/api/v1/graph/related/top-up", json=_top_up_body(*two, order="recent")
        )

    assert partial.status_code == 200
    ok, broken = partial.json()["sources"]
    assert (len(ok["added_group_keys"]), ok["error"]) == (30, None)
    assert (broken["added_group_keys"], broken["error"]) == ([], "provider_unavailable")
    assert partial.headers["X-RateLimit-Limit"] == "10"
    assert failed.status_code == 502
    assert failed.json()["detail"]["code"] == "related_provider_unavailable"


async def test_largest_top_up_payload_fits_the_body_limit(db, fake, seeds):
    def key(prefix: str, n: int) -> str:
        return f"group:{prefix}{n}".ljust(512, "x")

    body = _top_up_body(
        *[
            {
                "source_key": f"hash:{n}".ljust(512, "x"),
                "source_group_key": key("s", n),
                "connected_group_keys": [key(f"c{n}-", i) for i in range(60)],
            }
            for n in range(20)
        ],
        exclude_group_keys=[key("pin", i) for i in range(500)],
    )
    payload = json.dumps(body)
    assert 800_000 < len(payload) < 1024 * 1024

    async with _client(db) as client:
        response = await client.post(
            "/api/v1/graph/related/top-up",
            content=payload,
            headers={"Content-Type": "application/json"},
        )

    assert response.status_code == 200
    assert len(response.json()["sources"]) == 20
    assert fake.calls == 0


async def test_base_graph_reports_range_defaults_and_ignores_order(db, seeds, monkeypatch):
    async def no_references(_openalex_id):
        return []

    monkeypatch.setattr(registry, "get_openalex_reference_ids", no_references)

    async with _client(db) as client:
        default = await client.get(f"/api/v1/graph/paper/{SEED}")
        recent = await client.get(f"/api/v1/graph/paper/{SEED}", params={"order": "recent"})

    assert default.status_code == recent.status_code == 200
    assert (default.json()["related_range_size"], default.json()["related_max_results"]) == (
        30,
        10_000,
    )
    assert default.json()["nodes"] == recent.json()["nodes"]


@pytest.mark.parametrize("endpoint", ["related", "top-up"])
async def test_no_transaction_or_user_lock_is_held_during_provider_io(
    db, engine, fake, seeds, monkeypatch, endpoint
):
    user = await _make_user(db)
    headers = await _auth(db, user)
    observed: list[tuple[bool, bool | None]] = []

    async def observe():
        lock_free = None
        if ON_POSTGRES:
            async with AsyncSession(engine) as other:
                locked = await other.execute(
                    text("SELECT id FROM users WHERE id = :id FOR UPDATE NOWAIT"),
                    {"id": user.id},
                )
                lock_free = locked.first() is not None
                await other.rollback()
        observed.append((db.in_transaction(), lock_free))

    fake.observe = observe

    async def saved(_db, _user_id):
        return set()

    monkeypatch.setattr("app.graph.service.saved_canonical_keys", saved)

    async with _client(db) as client:
        if endpoint == "related":
            response = await client.post(
                "/api/v1/graph/related", json=_range_body(), headers=headers
            )
        else:
            response = await client.post(
                "/api/v1/graph/related/top-up", json=_top_up_body(), headers=headers
            )

    assert response.status_code == 200
    # One list page and one hydration batch, both outside any transaction.
    assert len(observed) == 2
    assert all(in_transaction is False for in_transaction, _ in observed)
    if ON_POSTGRES:
        assert all(lock_free is True for _, lock_free in observed)
