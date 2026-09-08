"""Real PostgreSQL locking regressions; SQLite cannot validate row-lock semantics."""

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.auth.models import AuthSession
from app.auth.service import create_session, revoke_user_sessions, rotate_session
from tests.test_auth import user_for_test


async def test_concurrent_refresh_replay_revokes_the_winner(db, engine):
    if engine.dialect.name != "postgresql":
        pytest.skip("Requires real PostgreSQL row locks (enabled in CI)")
    user = await user_for_test(db)
    _, raw = await create_session(db, user.id)
    await db.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def refresh():
        async with sessions() as transaction:
            result = await rotate_session(transaction, raw)
            await transaction.commit()
            return result

    results = await asyncio.wait_for(asyncio.gather(refresh(), refresh()), timeout=10)
    assert sum(result is not None for result in results) == 1
    rows = (
        (await db.execute(select(AuthSession).execution_options(populate_existing=True)))
        .scalars()
        .all()
    )
    assert len(rows) == 2 and all(row.revoked_at is not None for row in rows)


async def test_logout_all_racing_rotation_never_leaves_an_active_session(db, engine):
    if engine.dialect.name != "postgresql":
        pytest.skip("Requires real PostgreSQL row locks (enabled in CI)")
    user = await user_for_test(db)
    _, raw = await create_session(db, user.id)
    await db.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def refresh():
        async with sessions() as transaction:
            await rotate_session(transaction, raw)
            await transaction.commit()

    async def logout():
        async with sessions() as transaction:
            await revoke_user_sessions(transaction, user.id)
            await transaction.commit()

    await asyncio.wait_for(asyncio.gather(refresh(), logout()), timeout=10)
    rows = (
        (await db.execute(select(AuthSession).execution_options(populate_existing=True)))
        .scalars()
        .all()
    )
    assert all(row.revoked_at is not None for row in rows)
