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


@pytest.mark.parametrize("operation", ["verify", "complete"])
async def test_registration_concurrent_consumption(db, engine, operation):
    if engine.dialect.name != "postgresql":
        pytest.skip("Requires PostgreSQL advisory and row locks")
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import func

    from app.auth.registration import cookie_name
    from app.dependencies import get_db
    from app.main import create_app
    from app.users.models import User
    from tests.test_registration import COMPLETE, PREFIX, last_code

    app = create_app()
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def dependency():
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = dependency
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        assert (
            await c.post(PREFIX + "/start", json={"email": "race@example.com"})
        ).status_code == 202
        code = await last_code(db)
        # Release test read transaction before competing writers.
        await db.commit()
        if operation == "complete":
            assert (await c.post(PREFIX + "/verify", json={"code": code})).status_code == 200
        raw = c.cookies.get(cookie_name())

    async def submit():
        async with AsyncClient(
            transport=transport, base_url="http://testserver", cookies={cookie_name(): raw}
        ) as c:
            return await c.post(
                PREFIX + "/" + operation, json={"code": code} if operation == "verify" else COMPLETE
            )

    results = await asyncio.wait_for(asyncio.gather(submit(), submit()), timeout=15)
    assert sorted(r.status_code for r in results) == [200, 400]
    assert await db.scalar(select(func.count()).select_from(User)) == (
        1 if operation == "complete" else 0
    )


async def test_registration_distinct_challenges_cannot_create_two_accounts(db, engine):
    if engine.dialect.name != "postgresql":
        pytest.skip("Requires PostgreSQL advisory and row locks")
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import func

    from app.dependencies import get_db
    from app.main import create_app
    from app.users.models import User
    from tests.test_registration import COMPLETE, PREFIX, last_code

    app = create_app()
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def dependency():
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = dependency
    async with (
        AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as first,
        AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as second,
    ):
        for client in (first, second):
            assert (
                await client.post(PREFIX + "/start", json={"email": "same@example.com"})
            ).status_code == 202
            code = await last_code(db)
            await db.commit()
            assert (await client.post(PREFIX + "/verify", json={"code": code})).status_code == 200
        results = await asyncio.wait_for(
            asyncio.gather(
                first.post(PREFIX + "/complete", json=COMPLETE),
                second.post(PREFIX + "/complete", json=COMPLETE),
            ),
            timeout=15,
        )
        assert sorted(r.status_code for r in results) == [200, 400]
    assert await db.scalar(select(func.count()).select_from(User)) == 1
