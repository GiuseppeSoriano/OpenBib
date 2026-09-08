"""Authentication, cookie, replay, and account lifecycle regression tests."""

import json
import uuid
from datetime import timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.auth.models import AuthSession, EmailOutbox
from app.auth.service import (
    active_session,
    consume_action_token,
    create_access_token,
    create_action_token,
    create_session,
    hash_password,
    revoke_session_token,
    rotate_session,
    token_digest,
    utcnow,
    verify_access_token,
    verify_password,
)
from app.common.crypto import EncryptedValue, keyring
from app.dependencies import get_db
from app.main import create_app
from app.users.models import User

PASSWORD = "correct horse battery staple"


async def user_for_test(db):
    user = User(
        email=f"{uuid.uuid4()}@example.com",
        password_hash=hash_password(PASSWORD),
        display_name="Reader",
        email_verified_at=utcnow(),
        terms_version="dev-1",
        privacy_version="dev-1",
    )
    db.add(user)
    await db.flush()
    return user


@pytest.fixture
def client_app(db):
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


def test_password_and_required_jwt_claims():
    hashed = hash_password(PASSWORD)
    assert hashed.startswith("$argon2id$")
    assert verify_password(PASSWORD, hashed)
    assert not verify_password("wrong", hashed)
    assert not verify_password(PASSWORD, None)
    user_id, sid = uuid.uuid4(), uuid.uuid4()
    payload = verify_access_token(create_access_token(user_id, sid))
    assert payload["sub"] == str(user_id)
    assert payload["sid"] == str(sid)
    assert payload["type"] == "access"
    assert payload["exp"] - payload["iat"] == 600
    assert {"iss", "aud", "jti"} <= payload.keys()
    assert verify_access_token("invalid") is None


async def test_rotation_absolute_expiry_and_replay(db):
    user = await user_for_test(db)
    first, raw = await create_session(db, user.id)
    assert first.token_digest == token_digest(raw) and raw not in first.token_digest
    second, replacement = await rotate_session(db, raw)
    assert replacement != raw
    assert second.expires_at == first.expires_at
    assert first.replaced_by_id == second.id
    assert await rotate_session(db, raw) is None
    assert await active_session(db, second.id, user.id) is None


async def test_logout_revokes_whole_family(db):
    user = await user_for_test(db)
    first, raw = await create_session(db, user.id)
    second, replacement = await rotate_session(db, raw)
    await revoke_session_token(db, replacement)
    assert await active_session(db, first.id, user.id) is None
    assert await active_session(db, second.id, user.id) is None


async def test_action_tokens_are_monouse_and_expire(db):
    user = await user_for_test(db)
    raw = await create_action_token(db, user.id, "verify_email", timedelta(hours=24))
    assert await consume_action_token(db, raw, "reset_password") is None
    assert await consume_action_token(db, raw, "verify_email") is not None
    assert await consume_action_token(db, raw, "verify_email") is None
    expired = await create_action_token(db, user.id, "reset_password", timedelta(seconds=-1))
    assert await consume_action_token(db, expired, "reset_password") is None


async def test_http_replay_persists_revocation_and_clears_cookie(db, client_app):
    user = await user_for_test(db)
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as client:
        login = await client.post(
            "/api/v1/auth/login", json={"email": user.email, "password": PASSWORD}
        )
        assert login.status_code == 200
        assert "refresh_token" not in login.json()
        cookie = login.headers["set-cookie"]
        assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Path=/" in cookie
        raw = client.cookies.get("openbib_refresh")
        refreshed = await client.post("/api/v1/auth/refresh")
        assert refreshed.status_code == 200
        access = refreshed.json()["access_token"]
        replay = await client.post(
            "/api/v1/auth/refresh", headers={"cookie": f"openbib_refresh={raw}"}
        )
        assert replay.status_code == 401
        assert "Max-Age=0" in replay.headers["set-cookie"]
        denied = await client.get("/api/v1/users/me", headers={"authorization": f"Bearer {access}"})
        assert denied.status_code == 401
    rows = (await db.execute(select(AuthSession))).scalars().all()
    assert all(row.revoked_at is not None for row in rows)


async def test_registration_verification_and_no_overwrite(db, client_app):
    email = "new@example.com"
    body = {
        "email": email.upper(),
        "password": PASSWORD,
        "display_name": "New reader",
        "locale": "it",
        "accept_terms": True,
        "terms_version": "dev-1",
        "privacy_version": "dev-1",
    }
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as client:
        registered = await client.post("/api/v1/auth/register", json=body)
        assert registered.status_code == 202
        again = await client.post(
            "/api/v1/auth/register", json={**body, "password": "malicious replacement password"}
        )
        assert again.json() == registered.json()
        user = (await db.execute(select(User).where(User.email == email))).scalar_one()
        assert verify_password(PASSWORD, user.password_hash)
        outbox = (
            await db.execute(select(EmailOutbox).where(EmailOutbox.user_id == user.id))
        ).scalar_one()
        payload = keyring.decrypt(
            EncryptedValue(outbox.payload_ciphertext, outbox.payload_nonce, outbox.key_version),
            purpose="email",
            aad=f"email:{outbox.user_id}:{outbox.id}",
        )
        assert b"token=" not in outbox.payload_ciphertext
        token = json.loads(payload)["body"].split("#token=")[1]
        verified = await client.post(
            "/api/v1/auth/verify-email", json={"token": token, "new_password": PASSWORD}
        )
        assert verified.status_code == 200
        assert (
            await client.post(
                "/api/v1/auth/verify-email", json={"token": token, "new_password": PASSWORD}
            )
        ).status_code == 400


async def test_export_excludes_secrets_and_reset_revokes(db, client_app):
    user = await user_for_test(db)
    session, _ = await create_session(db, user.id)
    access = create_access_token(user.id, session.id)
    reset = await create_action_token(db, user.id, "reset_password", timedelta(hours=1))
    async with AsyncClient(
        transport=ASGITransport(app=client_app),
        base_url="http://testserver",
        headers={"authorization": f"Bearer {access}"},
    ) as client:
        exported = await client.post("/api/v1/users/me/export", json={"password": PASSWORD})
        assert exported.status_code == 200
        assert exported.json()["schema_version"] == 1
        assert {"library", "notes", "tags", "preferences", "zotero"} <= exported.json().keys()
        assert all(
            secret not in exported.text
            for secret in ("password_hash", "token_digest", "api_key", session.token_digest)
        )
        reset_response = await client.post(
            "/api/v1/auth/password/reset",
            json={"token": reset, "new_password": "another sufficiently long password"},
        )
        assert reset_response.status_code == 204
        assert (await client.get("/api/v1/users/me")).status_code == 401
