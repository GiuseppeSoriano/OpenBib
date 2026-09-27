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
