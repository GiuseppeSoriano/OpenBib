"""Authenticated encryption, input limits, and fail-closed protection."""

import base64
import json
import logging
import os
from dataclasses import replace

import pytest
from cryptography.exceptions import InvalidTag
from fastapi import HTTPException, Request, Response
from httpx import ASGITransport, AsyncClient

from app.common.crypto import EncryptionKeyring
from app.common.logging_config import JsonFormatter
from app.common.rate_limit import enforce_rate_limit
from app.config import Settings
from app.main import create_app


def test_crypto_nonce_aad_tamper_version_and_rotation():
    keys = json.dumps(
        {
            "1": base64.b64encode(os.urandom(32)).decode(),
            "2": base64.b64encode(os.urandom(32)).decode(),
        }
    )
    old = EncryptionKeyring(keys, 1)
    new = EncryptionKeyring(keys, 2)
    first = old.encrypt("private key", purpose="zotero", aad="user:1")
    assert first.nonce != old.encrypt("private key", purpose="zotero", aad="user:1").nonce
    assert new.decrypt(first, purpose="zotero", aad="user:1") == "private key"
    for value, purpose, aad in (
        (first, "email", "user:1"),
        (first, "zotero", "user:2"),
        (
            replace(first, ciphertext=first.ciphertext[:-1] + bytes([first.ciphertext[-1] ^ 1])),
            "zotero",
            "user:1",
        ),
    ):
        with pytest.raises(InvalidTag):
            old.decrypt(value, purpose=purpose, aad=aad)
    with pytest.raises(ValueError):
        old.decrypt(replace(first, key_version=99), purpose="zotero", aad="user:1")
    rotated = new.encrypt(
        new.decrypt(first, purpose="zotero", aad="user:1"), purpose="zotero", aad="user:1"
    )
    assert rotated.key_version == 2


async def test_atomic_bucket_hmac_and_retry(redis_backend):
    request = Request({"type": "http", "client": ("127.0.0.1", 123)})
    for _ in range(2):
        await enforce_rate_limit(
            redis_backend,
            request,
            Response(),
            scope="test",
            identity="private@example.com",
            limit=2,
            window_seconds=600,
            fail_closed=True,
        )
    with pytest.raises(HTTPException) as caught:
        await enforce_rate_limit(
            redis_backend,
            request,
            Response(),
            scope="test",
            identity="private@example.com",
            limit=2,
            window_seconds=600,
            fail_closed=True,
        )
    assert caught.value.status_code == 429
    assert int(caught.value.headers["Retry-After"]) > 0
    assert all("private" not in key for key in await redis_backend.keys("rate:*"))


async def test_redis_outage_policy():
    class Unavailable:
        async def eval(self, *args):
            raise ConnectionError("redis://password@host")

    request = Request({"type": "http"})
    kwargs = dict(scope="test", identity="ip", limit=10, window_seconds=60)
    with pytest.raises(HTTPException) as caught:
        await enforce_rate_limit(Unavailable(), request, None, **kwargs, fail_closed=True)
    assert caught.value.status_code == 503
    await enforce_rate_limit(Unavailable(), request, None, **kwargs, fail_closed=False)


async def test_oversized_chunked_body_and_hostile_request_id():
    app = create_app()

    async def chunks():
        yield b"x" * (1024 * 1024)
        yield b"x"

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post("/api/v1/auth/login", content=chunks())
        assert response.status_code == 413
        live = await client.get("/api/health/live", headers={"X-Request-ID": "x" * 65})
        assert live.status_code == 200
        assert len(live.headers["X-Request-ID"]) == 36
        invalid = await client.get(
            "/api/v1/papers/search", params={"q": "test", "providers": "evil"}
        )
        assert invalid.status_code == 422
        graph = await client.post("/api/v1/graph/expand", json={"from_keys": ["key"] * 21})
        assert graph.status_code == 422


def test_logs_drop_external_urls_and_exception_details():
    record = logging.LogRecord(
        "httpx", logging.ERROR, "", 1, "GET https://user:password@host/?token=secret", (), None
    )
    result = JsonFormatter().format(record)
    assert "password" not in result and "secret" not in result


def test_production_rejects_defaults():
    with pytest.raises(ValueError):
        Settings(environment="production", _env_file=None)


async def test_administrative_credential_rotation_is_idempotent(db, engine, monkeypatch):
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.zotero.models import ZoteroCredentials
    from scripts import rotate_credentials
    from tests.test_auth import user_for_test

    user = await user_for_test(db)
    keys = json.dumps(
        {str(version): base64.b64encode(os.urandom(32)).decode() for version in (1, 2)}
    )
    old, new = EncryptionKeyring(keys, 1), EncryptionKeyring(keys, 2)
    value = old.encrypt("private fixture", purpose="zotero", aad=f"zotero:{user.id}")
    db.add(
        ZoteroCredentials(
            user_id=user.id,
            zotero_user_id="123",
            api_key_ciphertext=value.ciphertext,
            api_key_nonce=value.nonce,
            api_key_version=1,
            api_key_last_four="ture",
        )
    )
    await db.commit()
    monkeypatch.setattr(rotate_credentials, "keyring", new)
    monkeypatch.setattr(
        rotate_credentials,
        "async_session_factory",
        async_sessionmaker(engine, expire_on_commit=False),
    )
    assert await rotate_credentials.rotate() == 1
    assert await rotate_credentials.rotate() == 0
    updated = await db.get(ZoteroCredentials, user.id, populate_existing=True)
    from app.common.crypto import EncryptedValue

    assert updated.api_key_version == 2
    assert (
        new.decrypt(
            EncryptedValue(
                updated.api_key_ciphertext, updated.api_key_nonce, updated.api_key_version
            ),
            purpose="zotero",
            aad=f"zotero:{user.id}",
        )
        == "private fixture"
    )
