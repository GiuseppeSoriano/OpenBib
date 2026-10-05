"""Shared test fixtures."""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from uuid import uuid4

import pytest
import pytest_asyncio
from fakeredis.aioredis import FakeRedis
from sqlalchemy import event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles

from app.auth import models as auth_models  # noqa: F401
from app.collections import models as collection_models  # noqa: F401
from app.database import Base
from app.graph import models as graph_models  # noqa: F401
from app.library import models as library_models  # noqa: F401
from app.notes import models as note_models  # noqa: F401
from app.papers import models as paper_models  # noqa: F401
from app.users import models as user_models  # noqa: F401
from app.zotero import models as zotero_models  # noqa: F401

# Use in-memory SQLite by default, but allow Docker/Postgres override.
TEST_DB_URL = os.getenv("TEST_DB_URL", "sqlite+aiosqlite:///:memory:")


@compiles(JSONB, "sqlite")
def compile_jsonb_sqlite(_element, _compiler, **_kw):
    return "JSON"


@pytest_asyncio.fixture
async def engine():
    tables = list(Base.metadata.tables.values())
    eng = create_async_engine(TEST_DB_URL, echo=False)
    if TEST_DB_URL.startswith("sqlite"):

        @event.listens_for(eng.sync_engine, "connect")
        def enable_foreign_keys(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")
    elif not TEST_DB_URL.rstrip("/").endswith("_test"):
        raise RuntimeError("TEST_DB_URL must target a disposable database ending in _test")
    async with eng.begin() as conn:
        await conn.run_sync(lambda sync_conn: Base.metadata.create_all(sync_conn, tables=tables))
    yield eng
    async with eng.begin() as conn:
        await conn.run_sync(lambda sync_conn: Base.metadata.drop_all(sync_conn, tables=tables))
    await eng.dispose()


@pytest_asyncio.fixture
async def db(engine) -> AsyncGenerator[AsyncSession, None]:
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session
        await session.rollback()


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch):
    # Local .env credentials and backup preferences must not affect unit tests.
    from app.config import Settings, settings

    defaults = Settings(_env_file=None)
    for name in Settings.model_fields:
        monkeypatch.setattr(settings, name, getattr(defaults, name))


@pytest_asyncio.fixture(autouse=True)
async def redis_backend(monkeypatch, isolated_settings):
    import redis.asyncio as redis

    original = redis.from_url
    pool = (
        original(os.environ["TEST_REDIS_URL"], decode_responses=True)
        if os.getenv("TEST_REDIS_URL")
        else FakeRedis(decode_responses=True)
    )
    monkeypatch.setattr(redis, "from_url", lambda *args, **kwargs: pool)
    await pool.flushdb()
    yield pool
    await pool.aclose()


@pytest.fixture(autouse=True)
def hermetic_doi_resolution(monkeypatch, isolated_settings):
    """No test may reach a real DOI provider or doi.org: the API key is forced
    blank (even when the environment exports one), so the primary provider
    fails before any HTTP call and every uncached DOI resolves as
    ``unavailable`` (stored as pending)."""
    from pydantic import SecretStr

    from app.config import settings
    from app.providers import registry

    async def handle_check_failed(_doi: str) -> None:
        return None

    monkeypatch.setattr(settings, "semantic_scholar_api_key", SecretStr(""))
    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", None)
    monkeypatch.setattr(registry, "doi_handle_exists", handle_check_failed)


class S2Mock:
    """Semantic Scholar on ``httpx.MockTransport``. Queue outcomes in
    ``responses`` (a JSON body, an ``httpx.Response`` or an exception to
    raise) or set ``handler(request)``; every request lands in ``calls``."""

    def __init__(self) -> None:
        self.responses: list = []
        self.calls: list = []
        self.handler = None
        self.provider = None

    def __call__(self, request):
        import httpx

        assert request.url.host == "api.semanticscholar.org"
        assert request.headers["x-api-key"] == "mock-private-key"
        assert "mock-private-key" not in str(request.url)
        self.calls.append(request)
        outcome = self.handler(request) if self.handler else self.responses.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome if isinstance(outcome, httpx.Response) else httpx.Response(200, json=outcome)


@pytest_asyncio.fixture
async def s2_mock(monkeypatch, hermetic_doi_resolution):
    """The registry's Semantic Scholar provider with a mock key, no pacing or
    backoff waits, and every HTTP call answered by an ``S2Mock``."""
    from unittest.mock import AsyncMock

    import httpx
    from pydantic import SecretStr

    from app.config import settings
    from app.providers import registry
    from app.providers.semantic_scholar import SemanticScholarProvider

    monkeypatch.setattr(settings, "semantic_scholar_api_key", SecretStr("mock-private-key"))
    mock = S2Mock()
    mock.provider = SemanticScholarProvider(transport=httpx.MockTransport(mock))
    mock.provider._limiter.acquire = AsyncMock()
    mock.provider._sleep = AsyncMock()
    monkeypatch.setattr(registry, "_instances", {"semantic_scholar": mock.provider})
    yield mock
    await mock.provider.close()


@pytest.fixture
def user_id():
    return uuid4()


@pytest.fixture
def client_app(db):
    from app.dependencies import get_db
    from app.main import create_app

    app = create_app()

    async def dependency():
        try:
            yield db
            await db.commit()
        except Exception:
            await db.rollback()
            raise

    app.dependency_overrides[get_db] = dependency
    return app
