"""Deletion ownership, legal acceptance, email change, and cookie integration."""

from datetime import timedelta

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.auth.models import AccountDeletionTombstone, EmailOutbox
from app.auth.service import create_access_token, create_action_token, create_session, utcnow
from app.collections.models import Collection, CollectionMember, CollectionPaper
from app.config import settings
from app.dependencies import get_db
from app.main import create_app
from app.notes.models import Note
from app.users.service import delete_user_account
from tests.test_auth import PASSWORD, user_for_test


async def test_deletion_transfers_editor_before_older_viewer_and_removes_private_data(db):
    owner, viewer, editor = [await user_for_test(db) for _ in range(3)]
    shared = Collection(owner_id=owner.id, name="Shared")
    solo = Collection(owner_id=owner.id, name="Solo")
    db.add_all([shared, solo])
    await db.flush()
    db.add_all(
        [
            CollectionMember(collection_id=shared.id, user_id=owner.id, role="owner"),
            CollectionMember(
                collection_id=shared.id,
                user_id=viewer.id,
                role="viewer",
                joined_at=utcnow() - timedelta(days=2),
            ),
            CollectionMember(
                collection_id=shared.id, user_id=editor.id, role="editor", joined_at=utcnow()
            ),
            CollectionPaper(
                collection_id=shared.id, paper_canonical_key="doi:shared", added_by=owner.id
            ),
            Note(
                user_id=owner.id,
                target_type="paper",
                target_key="doi:shared",
                content="private note",
            ),
            EmailOutbox(user_id=owner.id, payload_ciphertext=b"encrypted pending mail"),
        ]
    )
    await db.flush()
    await delete_user_account(db, owner)
    await db.flush()
    assert (await db.get(Collection, shared.id, populate_existing=True)).owner_id == editor.id
    assert await db.get(Collection, solo.id) is None
    assert not (await db.execute(select(Note).where(Note.user_id == owner.id))).scalars().all()
    assert (
        not (await db.execute(select(EmailOutbox).where(EmailOutbox.user_id == owner.id)))
        .scalars()
        .all()
    )
    paper = (
        await db.execute(
            select(CollectionPaper)
            .where(CollectionPaper.collection_id == shared.id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert paper.added_by is None
    assert await db.get(AccountDeletionTombstone, owner.id) is not None


async def test_deletion_uuid_tie_break(db):
    owner, first, second = [await user_for_test(db) for _ in range(3)]
    coll = Collection(owner_id=owner.id, name="Tie")
    db.add(coll)
    await db.flush()
    joined = utcnow()
    db.add_all(
        [
            CollectionMember(
                collection_id=coll.id, user_id=user.id, role="editor", joined_at=joined
            )
            for user in (first, second)
        ]
    )
    await db.flush()
    await delete_user_account(db, owner)
    await db.flush()
    assert coll.owner_id == min((first.id, second.id), key=str)


async def test_production_cookie_origin_and_legal_gate(db, monkeypatch):
    user = await user_for_test(db)
    user.terms_version = "old"
    app = create_app()

    async def dependency():
        yield db

    app.dependency_overrides[get_db] = dependency
    # Load dev legal fixture before isolating the runtime origin/cookie policy.
    from app.legal import get_legal_config

    get_legal_config()
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "cookie_secure", True)
    monkeypatch.setattr(settings, "app_public_url", "https://testserver")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="https://testserver"
    ) as client:
        invalid = await client.post(
            "/api/v1/auth/login", json={"email": user.email, "password": PASSWORD}
        )
        assert invalid.status_code == 403
        logged = await client.post(
            "/api/v1/auth/login",
            json={"email": user.email, "password": PASSWORD},
            headers={"Origin": "https://testserver"},
        )
        assert logged.status_code == 200
        assert "__Host-openbib_refresh=" in logged.headers["set-cookie"]
        assert (
            "Secure" in logged.headers["set-cookie"]
            and "Domain=" not in logged.headers["set-cookie"]
        )
        headers = {
            "Authorization": f"Bearer {logged.json()['access_token']}",
        }
        assert (await client.get("/api/v1/collections", headers=headers)).status_code == 403
        accepted = await client.post(
            "/api/v1/users/me/legal-acceptance",
            headers=headers,
            json={"accept_terms": True, "terms_version": "dev-1", "privacy_version": "dev-1"},
        )
        assert accepted.status_code == 200
        rejected_logout = await client.post("/api/v1/auth/logout", headers=headers)
        assert rejected_logout.status_code == 403


async def test_email_confirmation_revokes_sessions(db):
    user = await user_for_test(db)
    session, _ = await create_session(db, user.id)
    token = await create_action_token(
        db, user.id, "change_email", timedelta(hours=24), "changed@example.com"
    )
    app = create_app()

    async def dependency():
        yield db

    app.dependency_overrides[get_db] = dependency
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        assert (
            await client.post("/api/v1/auth/email/confirm", json={"token": token})
        ).status_code == 204
        assert user.email == "changed@example.com"
        headers = {"Authorization": f"Bearer {create_access_token(user.id, session.id)}"}
        assert (await client.get("/api/v1/users/me", headers=headers)).status_code == 401
        assert (
            await client.post("/api/v1/auth/email/confirm", json={"token": token})
        ).status_code == 400


async def test_email_change_unique_constraint_is_atomic_under_concurrency(db, engine, monkeypatch):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    import app.dependencies as dependencies

    first, second = [await user_for_test(db) for _ in range(2)]
    target = "shared-target@example.com"
    tokens = [
        await create_action_token(db, user.id, "change_email", timedelta(hours=24), target)
        for user in (first, second)
    ]
    await db.commit()
    monkeypatch.setattr(
        dependencies, "async_session_factory", async_sessionmaker(engine, expire_on_commit=False)
    )
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://testserver"
    ) as client:
        if engine.dialect.name == "postgresql":
            results = await asyncio.gather(
                *(
                    client.post("/api/v1/auth/email/confirm", json={"token": token})
                    for token in tokens
                )
            )
        else:
            results = [
                await client.post("/api/v1/auth/email/confirm", json={"token": token})
                for token in tokens
            ]
    assert sorted(result.status_code for result in results) == [204, 409]


async def test_password_reset_invalidates_preexisting_email_change(db, monkeypatch):
    from app.auth.service import consume_action_token

    user = await user_for_test(db)
    change = await create_action_token(
        db, user.id, "change_email", timedelta(hours=24), "other@example.com"
    )
    reset = await create_action_token(db, user.id, "reset_password", timedelta(hours=1))
    app = create_app()

    async def dependency():
        yield db

    app.dependency_overrides[get_db] = dependency
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/api/v1/auth/password/reset", json={"token": reset, "new_password": PASSWORD + " new"}
        )
        assert response.status_code == 204
    assert await consume_action_token(db, change, "change_email") is None
