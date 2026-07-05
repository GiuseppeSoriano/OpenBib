"""Shared test fixtures."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncGenerator
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.auth import models as auth_models  # noqa: F401
from app.collections import models as collection_models  # noqa: F401
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


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def engine():
    tables = [
        table
        for name, table in Base.metadata.tables.items()
        if not (TEST_DB_URL.startswith("sqlite") and name == "user_preferences")
    ]
    eng = create_async_engine(TEST_DB_URL, echo=False)
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


@pytest.fixture
def user_id():
    return uuid4()
