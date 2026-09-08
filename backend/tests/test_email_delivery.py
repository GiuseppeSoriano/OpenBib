"""Outbox encryption, bounded retries, and deletion-journal persistence."""

import io
import json
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.auth import email_worker
from app.auth.email import queue_email
from app.auth.models import EmailOutbox
from app.auth.service import utcnow
from app.common import deletion_journal
from app.config import settings
from app.users.models import User
from scripts import replay_deletions
from tests.test_auth import user_for_test


async def test_email_delivery_clears_encrypted_payload(db, engine, monkeypatch):
    user = await user_for_test(db)
    await queue_email(db, user.id, user.email, "Verify", "private #token=not-for-logs")
    await db.commit()
    monkeypatch.setattr(
        email_worker, "async_session_factory", async_sessionmaker(engine, expire_on_commit=False)
    )
    send = AsyncMock()
    monkeypatch.setattr(email_worker.aiosmtplib, "send", send)
    assert await email_worker.deliver_one()
    assert "private #token=not-for-logs" in send.call_args.args[0].get_content()
    row = (
        await db.execute(select(EmailOutbox).execution_options(populate_existing=True))
    ).scalar_one()
    assert row.sent_at is not None
    assert row.payload_ciphertext is row.payload_nonce is row.key_version is None
    assert not await email_worker.deliver_one()


async def test_email_retry_is_bounded_and_errors_never_contain_secrets(db, engine, monkeypatch):
    user = await user_for_test(db)
    await queue_email(db, user.id, user.email, "Reset", "private payload")
    await db.commit()
    monkeypatch.setattr(
        email_worker, "async_session_factory", async_sessionmaker(engine, expire_on_commit=False)
    )
    monkeypatch.setattr(
        email_worker.aiosmtplib,
        "send",
        AsyncMock(side_effect=ConnectionError("smtp://user:secret@host")),
    )
    for attempt in range(1, 6):
        assert await email_worker.deliver_one()
        row = (
            await db.execute(select(EmailOutbox).execution_options(populate_existing=True))
        ).scalar_one()
        assert row.attempts == attempt
        assert row.last_error == "ConnectionError"
        if attempt < 5:
            assert row.payload_ciphertext is not None
            assert not await email_worker.deliver_one()
            row.next_attempt_at = utcnow() - timedelta(seconds=1)
            await db.commit()
    assert row.failed_at is not None
    assert row.payload_ciphertext is row.payload_nonce is row.key_version is None
    assert not await email_worker.deliver_one()


async def test_deletion_receipt_is_encrypted_and_replay_is_idempotent(db, engine, monkeypatch):
    user = await user_for_test(db)
    await db.commit()
    objects = {}

    class S3:
        def put_object(self, **kwargs):
            objects[kwargs["Key"]] = kwargs["Body"]

        def get_paginator(self, _name):
            return self

        def paginate(self, **_kwargs):
            return [{"Contents": [{"Key": key} for key in objects]}]

        def get_object(self, **kwargs):
            return {"Body": io.BytesIO(objects[kwargs["Key"]])}

    monkeypatch.setattr(deletion_journal, "client", S3)
    monkeypatch.setattr(settings, "environment", "production")
    await deletion_journal.record_deletion(user.id)
    monkeypatch.setattr(settings, "environment", "test")
    body = next(iter(objects.values()))
    assert user.email.encode() not in body and str(user.id).encode() not in body
    assert set(json.loads(body)) == {"version", "nonce", "ciphertext"}
    assert deletion_journal.read_receipts()[0]["user_id"] == str(user.id)
    monkeypatch.setattr(
        replay_deletions,
        "async_session_factory",
        async_sessionmaker(engine, expire_on_commit=False),
    )
    assert await replay_deletions.replay(False) == 1
    assert await db.get(User, user.id, populate_existing=True) is not None
    assert await replay_deletions.replay(True) == 1
    assert await replay_deletions.replay(True) == 0
    assert await db.get(User, user.id, populate_existing=True) is None


async def test_failed_deletion_journal_prevents_account_removal(db, monkeypatch):
    from app.users.service import delete_user_account

    user = await user_for_test(db)
    monkeypatch.setattr(
        deletion_journal,
        "record_deletion",
        AsyncMock(side_effect=ConnectionError("private endpoint")),
    )
    with pytest.raises(ConnectionError):
        await delete_user_account(db, user)
    assert await db.get(User, user.id) is not None
