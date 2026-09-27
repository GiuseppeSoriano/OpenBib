"""Registration contracts, security boundaries, encrypted mail and lifecycle."""

import json
import re
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.auth import email_worker, maintenance, registration
from app.auth.email import lifecycle_email
from app.auth.models import EmailOutbox, RegistrationChallenge, UserActionToken
from app.auth.service import create_action_token, create_session, utcnow, verify_password
from app.common.crypto import EncryptedValue, keyring
from app.config import settings
from app.users.models import User
from tests.test_auth import PASSWORD, user_for_test

PREFIX = "/api/v1/auth/registration"
COMPLETE = {
    "display_name": "New Reader",
    "password": PASSWORD,
    "accept_terms": True,
    "terms_version": "dev-1",
    "privacy_version": "dev-1",
}


@pytest.mark.parametrize("length,accepted", [(7, False), (8, True), (128, True), (129, False)])
def test_password_length_contracts(length, accepted):
    from pydantic import ValidationError

    from app.auth.schemas import (
        PasswordChangeRequest,
        PasswordResetRequest,
        RegistrationCompleteRequest,
    )

    for schema, body in [
        (RegistrationCompleteRequest, {**COMPLETE, "password": "p" * length}),
        (PasswordResetRequest, {"token": "t" * 43, "new_password": "p" * length}),
        (PasswordChangeRequest, {"current_password": PASSWORD, "new_password": "p" * length}),
    ]:
        if accepted:
            schema(**body)
        else:
            with pytest.raises(ValidationError):
                schema(**body)


def payload(row):
    return json.loads(
        keyring.decrypt(
            EncryptedValue(row.payload_ciphertext, row.payload_nonce, row.key_version),
            purpose="email",
            aad=f"email:{row.user_id}:{row.id}",
        )
    )


async def last_code(db):
    rows = (
        (await db.execute(select(EmailOutbox).order_by(EmailOutbox.created_at, EmailOutbox.id)))
        .scalars()
        .all()
    )
    return re.search(r"\n\n([0-9]{6})\n\n", payload(rows[-1])["body"]).group(1)


async def begin(c, db, email="new@example.com"):
    r = await c.post(PREFIX + "/start", json={"email": email, "locale": "it"})
    assert r.status_code == 202
    return r, await last_code(db)


async def challenge(db):
    return (await db.execute(select(RegistrationChallenge))).scalar_one()


async def test_complete_flow_cookie_rotation_and_no_password_before_verification(
    db, client_app, monkeypatch
):
    monkeypatch.setattr(registration.secrets, "randbelow", lambda n: 42)
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        r, code = await begin(c, db, "NEW@example.com")
        assert code == "000042"
        assert r.json()["stage"] == "otp" and r.json()["email_masked"] == "n***@example.com"
        assert all(
            flag in r.headers["set-cookie"] for flag in ["HttpOnly", "SameSite=strict", "Path=/"]
        )
        assert code not in r.text and "cookie_digest" not in r.text
        assert await db.scalar(select(func.count()).select_from(User)) == 0
        raw = c.cookies.get(registration.cookie_name())
        row = await challenge(db)
        assert raw not in row.cookie_digest and code not in row.otp_digest
        assert (await c.post(PREFIX + "/complete", json=COMPLETE)).status_code == 400
        verified = await c.post(PREFIX + "/verify", json={"code": code})
        assert verified.status_code == 200 and verified.json()["stage"] == "profile"
        assert c.cookies.get(registration.cookie_name()) != raw
        assert (await c.get("/api/v1/users/me")).status_code == 401
        assert (await c.get(PREFIX + "/status")).json()["stage"] == "profile"
        assert (await c.post(PREFIX + "/verify", json={"code": code})).status_code == 400
        assert (
            await c.post(
                PREFIX + "/complete",
                json=COMPLETE,
                headers={"cookie": f"{registration.cookie_name()}={raw}"},
            )
        ).status_code == 400
        done = await c.post(PREFIX + "/complete", json=COMPLETE)
        assert done.status_code == 200 and "access_token" in done.json()
        assert c.cookies.get(registration.cookie_name()) is None
        user = (await db.execute(select(User))).scalar_one()
        assert (
            user.email == "new@example.com"
            and user.email_verified_at
            and verify_password(PASSWORD, user.password_hash)
        )
        assert user.terms_version == "dev-1" and user.privacy_version == "dev-1"
        assert (
            await c.get(
                "/api/v1/users/me",
                headers={"Authorization": "Bearer " + done.json()["access_token"]},
            )
        ).status_code == 200
        assert (
            await c.post("/api/v1/auth/login", json={"email": user.email, "password": PASSWORD})
        ).status_code == 200
        assert (await c.post(PREFIX + "/complete", json=COMPLETE)).status_code == 400


async def test_wrong_attempts_commit_and_resend_does_not_reset_them(db, client_app):
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        _, code = await begin(c, db)
        wrong = "999999" if code != "999999" else "000000"
        assert (await c.post(PREFIX + "/resend")).status_code == 429
        for _ in range(2):
            assert (await c.post(PREFIX + "/verify", json={"code": wrong})).json()[
                "detail"
            ] == "registration_code_invalid"
        row = await challenge(db)
        await db.refresh(row)
        assert row.attempts == 2
        row.resend_at = utcnow() - timedelta(seconds=1)
        await db.commit()
        assert (await c.post(PREFIX + "/resend")).status_code == 202
        await db.refresh(row)
        assert row.attempts == 2 and row.generation == 2
        # HMAC is scoped to this generation, so the previous digest cannot validate.
        assert row.otp_digest == registration.otp_digest(row, await last_code(db))
        for _ in range(3):
            current = await last_code(db)
            wrong = "111111" if current != "111111" else "222222"
            r = await c.post(PREFIX + "/verify", json={"code": wrong})
        assert r.json()["detail"] == "registration_locked"
        await db.refresh(row)
        assert row.attempts == 5
        assert (await c.get(PREFIX + "/status")).json()["stage"] == "locked"
        assert (
            await c.post(PREFIX + "/verify", json={"code": await last_code(db)})
        ).status_code == 400
        assert (await c.post(PREFIX + "/resend")).status_code == 400


async def test_expiry_resend_and_completion_deadline(db, client_app):
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        _, code = await begin(c, db)
        row = await challenge(db)
        row.otp_expires_at = utcnow() - timedelta(seconds=1)
        await db.commit()
        assert (await c.post(PREFIX + "/verify", json={"code": code})).json()[
            "detail"
        ] == "registration_code_expired"
        row.resend_at = utcnow() - timedelta(seconds=1)
        await db.commit()
        assert (await c.post(PREFIX + "/resend")).status_code == 202
        assert (
            await c.post(PREFIX + "/verify", json={"code": await last_code(db)})
        ).status_code == 200
        await db.refresh(row)
        row.expires_at = utcnow() - timedelta(seconds=1)
        await db.commit()
        assert (await c.get(PREFIX + "/status")).json()["stage"] == "expired"
        assert (await c.post(PREFIX + "/complete", json=COMPLETE)).status_code == 400
        assert await db.scalar(select(func.count()).select_from(User)) == 0


async def test_resend_rejects_previous_code_even_if_random_generator_repeats(
    db, client_app, monkeypatch
):
    values = iter([42, 42, 0])
    monkeypatch.setattr(registration.secrets, "randbelow", lambda n: next(values))
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        _, old = await begin(c, db)
        row = await challenge(db)
        row.resend_at = utcnow() - timedelta(seconds=1)
        await db.commit()
        assert (await c.post(PREFIX + "/resend")).status_code == 202
        new = await last_code(db)
        assert old == "000042" and new == "000043"
        assert (await c.post(PREFIX + "/verify", json={"code": old})).json()[
            "detail"
        ] == "registration_code_invalid"
        assert (await c.post(PREFIX + "/verify", json={"code": new})).status_code == 200


async def test_email_limit_shared_across_ips_and_verify_ip_limit(db, client_app):
    for index in range(5):
        async with AsyncClient(
            transport=ASGITransport(app=client_app, client=(f"192.0.2.{index}", 1234)),
            base_url="http://testserver",
        ) as c:
            assert (
                await c.post(PREFIX + "/start", json={"email": "limited@example.com"})
            ).status_code == 202
    async with AsyncClient(
        transport=ASGITransport(app=client_app, client=("192.0.2.99", 1234)),
        base_url="http://testserver",
    ) as c:
        assert (
            await c.post(PREFIX + "/start", json={"email": "LIMITED@example.com"})
        ).status_code == 429
        for _ in range(10):
            assert (await c.post(PREFIX + "/verify", json={"code": "000000"})).status_code == 400
        assert (await c.post(PREFIX + "/verify", json={"code": "000000"})).status_code == 429


async def test_verified_account_is_not_modified_or_sent_a_code(db, client_app):
    user = await user_for_test(db)
    old_hash = user.password_hash
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        r = await c.post(PREFIX + "/start", json={"email": user.email})
        assert r.status_code == 202 and r.json()["stage"] == "otp"
        assert await db.scalar(select(func.count()).select_from(EmailOutbox)) == 0
        assert (await c.post(PREFIX + "/complete", json=COMPLETE)).status_code == 400
        await db.refresh(user)
        assert user.password_hash == old_hash


async def test_legacy_unverified_account_reclaimed_and_sibling_attempts_invalidated(db, client_app):
    user = await user_for_test(db)
    user.email_verified_at = None
    old_session, _ = await create_session(db, user.id)
    await create_action_token(db, user.id, "verify_email", timedelta(hours=24))
    async with (
        AsyncClient(
            transport=ASGITransport(app=client_app), base_url="http://testserver"
        ) as attacker,
        AsyncClient(transport=ASGITransport(app=client_app), base_url="http://testserver") as owner,
    ):
        await begin(attacker, db, user.email)
        _, code = await begin(owner, db, user.email)
        assert (await attacker.get(PREFIX + "/status")).json()["stage"] == "otp"
        assert (await owner.post(PREFIX + "/verify", json={"code": code})).status_code == 200
        assert (
            await owner.post(
                PREFIX + "/complete", json={**COMPLETE, "password": "mailbox owner chosen password"}
            )
        ).status_code == 200
        await db.refresh(user)
        await db.refresh(old_session)
        assert user.display_name == "New Reader" and verify_password(
            "mailbox owner chosen password", user.password_hash
        )
        assert old_session.revoked_at is not None
        assert await db.scalar(select(func.count()).select_from(User)) == 1
        assert (await attacker.get(PREFIX + "/status")).json()["stage"] == "expired"
        assert all(a.used_at for a in (await db.execute(select(UserActionToken))).scalars())


async def test_legal_change_preserves_verified_grant(db, client_app):
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        _, code = await begin(c, db)
        await c.post(PREFIX + "/verify", json={"code": code})
        assert (
            await c.post(PREFIX + "/complete", json={**COMPLETE, "terms_version": "old"})
        ).status_code == 409
        assert (await c.get(PREFIX + "/status")).json()["stage"] == "profile"
        assert (await c.post(PREFIX + "/complete", json=COMPLETE)).status_code == 200


async def test_shared_send_limits_and_redis_failure(db, client_app, redis_backend, monkeypatch):
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        await begin(c, db)
        row = await challenge(db)
        for _ in range(4):
            row.resend_at = utcnow() - timedelta(seconds=1)
            await db.commit()
            assert (await c.post(PREFIX + "/resend")).status_code == 202
        assert (
            await c.post(PREFIX + "/start", json={"email": "different@example.com"})
        ).status_code == 429
        monkeypatch.setattr(redis_backend, "eval", AsyncMock(side_effect=ConnectionError()))
        assert (await c.post(PREFIX + "/verify", json={"code": "000000"})).status_code == 503
        assert (
            await c.post(PREFIX + "/start", json={"email": "another@example.com"})
        ).status_code == 503


async def test_production_origin_and_secure_cookie(db, client_app, monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "cookie_secure", True)
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="https://testserver"
    ) as c:
        for suffix in ["start", "resend", "verify", "complete"]:
            r = await c.post(
                PREFIX + "/" + suffix, json={"email": "new@example.com", "code": "000000"}
            )
            assert r.status_code == 403
        r = await c.post(
            PREFIX + "/start",
            json={"email": "new@example.com"},
            headers={"Origin": settings.app_public_url.rstrip("/")},
        )
        assert r.status_code == 202
        assert (
            "__Host-openbib_registration=" in r.headers["set-cookie"]
            and "Secure" in r.headers["set-cookie"]
        )
        assert r.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("locale", ["it", "en"])
@pytest.mark.parametrize("kind", ["reset_password", "change_email"])
def test_branded_lifecycle_templates_escape_links_and_have_text(kind, locale, monkeypatch):
    monkeypatch.setattr(settings, "app_public_url", "https://openbib.example")
    subject, body, html = lifecycle_email(kind, locale, '<script>"&')
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert "cid:openbib-logo" in html and "https://openbib.example/privacy" in html
    assert '#token=<script>"&' in body and subject
    assert f'lang="{locale}"' in html and 'role="presentation"' in html


async def test_worker_multipart_and_obsolete_otp(db, engine, client_app, monkeypatch):
    monkeypatch.setattr(
        email_worker, "async_session_factory", async_sessionmaker(engine, expire_on_commit=False)
    )
    send = AsyncMock()
    monkeypatch.setattr(email_worker.aiosmtplib, "send", send)
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        await begin(c, db)
        row = await challenge(db)
        row.resend_at = utcnow() - timedelta(seconds=1)
        await db.commit()
        await c.post(PREFIX + "/resend")
        assert await email_worker.deliver_one()  # obsolete first code
        assert send.call_count == 0
        assert await email_worker.deliver_one()
        msg = send.call_args.args[0]
        assert msg.get_content_type() == "multipart/alternative"
        assert msg.get_body(preferencelist=("plain",)) and msg.get_body(preferencelist=("html",))
        image = next(p for p in msg.walk() if p.get_content_type() == "image/png")
        assert image["Content-ID"] == "<openbib-logo>" and image.get_payload(
            decode=True
        ).startswith(b"\x89PNG")
        row.resend_at = utcnow() - timedelta(seconds=1)
        await db.commit()
        await c.post(PREFIX + "/resend")
        await c.post(PREFIX + "/verify", json={"code": await last_code(db)})
        assert await email_worker.deliver_one()
        assert send.call_count == 1
    rows = (
        (await db.execute(select(EmailOutbox).execution_options(populate_existing=True)))
        .scalars()
        .all()
    )
    assert all(r.payload_ciphertext is None for r in rows)


async def test_cleanup_removes_expired_challenges(db, engine, client_app, monkeypatch):
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        await begin(c, db)
    row = await challenge(db)
    row.expires_at = utcnow() - timedelta(days=2)
    await db.commit()
    monkeypatch.setattr(
        maintenance, "async_session_factory", async_sessionmaker(engine, expire_on_commit=False)
    )
    await maintenance.cleanup_expired_data()
    assert await db.scalar(select(func.count()).select_from(RegistrationChallenge)) == 0


@pytest.mark.parametrize("reason", ["expired", "locked", "used", "missing"])
async def test_worker_discards_unusable_challenges(db, engine, client_app, monkeypatch, reason):
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        await begin(c, db)
    row = await challenge(db)
    if reason == "expired":
        row.otp_expires_at = utcnow() - timedelta(seconds=1)
    elif reason == "locked":
        row.attempts = 5
    elif reason == "used":
        row.used_at = utcnow()
    else:
        await db.delete(row)
    await db.commit()
    monkeypatch.setattr(
        email_worker, "async_session_factory", async_sessionmaker(engine, expire_on_commit=False)
    )
    send = AsyncMock()
    monkeypatch.setattr(email_worker.aiosmtplib, "send", send)
    assert await email_worker.deliver_one()
    send.assert_not_called()
    queued = (
        await db.execute(select(EmailOutbox).execution_options(populate_existing=True))
    ).scalar_one()
    assert queued.last_error == "SupersededRegistration" and queued.payload_ciphertext is None
