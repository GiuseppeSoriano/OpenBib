"""Small SMTP worker for the encrypted database outbox."""

import asyncio
import json
import logging
import time
from datetime import timedelta
from email.message import EmailMessage
from pathlib import Path

import aiosmtplib
from sqlalchemy import select

from app.auth.models import EmailOutbox
from app.auth.service import utcnow
from app.common.crypto import EncryptedValue, keyring
from app.config import settings
from app.database import async_session_factory

logger = logging.getLogger("openbib.email")


async def deliver_one() -> bool:
    async with async_session_factory() as db:
        result = await db.execute(
            select(EmailOutbox)
            .where(
                EmailOutbox.sent_at.is_(None),
                EmailOutbox.failed_at.is_(None),
                EmailOutbox.next_attempt_at <= utcnow(),
            )
            .order_by(EmailOutbox.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        row = result.scalar_one_or_none()
        if (
            row is None
            or row.payload_ciphertext is None
            or row.payload_nonce is None
            or row.key_version is None
        ):
            return False
        try:
            raw = keyring.decrypt(
                EncryptedValue(row.payload_ciphertext, row.payload_nonce, row.key_version),
                purpose="email",
                aad=f"email:{row.user_id}:{row.id}",
            )
            payload = json.loads(raw)
            message = EmailMessage()
            message["From"] = settings.email_from
            message["To"] = payload["recipient"]
            message["Subject"] = payload["subject"]
            message.set_content(payload["body"])
            await aiosmtplib.send(
                message,
                hostname=settings.smtp_host or "mailpit",
                port=settings.smtp_port,
                username=settings.smtp_username or None,
                password=settings.smtp_password or None,
                start_tls=settings.smtp_starttls,
                timeout=10,
            )
        except Exception as exc:
            row.attempts += 1
            row.last_error = type(exc).__name__
            if row.attempts >= 5:
                row.failed_at = utcnow()
                row.payload_ciphertext = row.payload_nonce = None
                row.key_version = None
            else:
                row.next_attempt_at = utcnow() + timedelta(
                    seconds=min(3600, 30 * (2**row.attempts))
                )
            await db.commit()
            logger.warning(
                "Email delivery failed", extra={"outbox_id": str(row.id), "attempt": row.attempts}
            )
            return True
        row.sent_at = utcnow()
        row.payload_ciphertext = row.payload_nonce = None
        row.key_version = None
        row.last_error = None
        await db.commit()
        logger.info("Email delivered", extra={"outbox_id": str(row.id)})
        return True


async def run() -> None:
    from app.auth.maintenance import cleanup_expired_data
    from app.common.logging_config import configure_logging

    configure_logging(False)
    next_cleanup = 0.0
    while True:
        Path("/tmp/openbib-mail-heartbeat").write_text(str(time.time()))
        if asyncio.get_running_loop().time() >= next_cleanup:
            await cleanup_expired_data()
            next_cleanup = asyncio.get_running_loop().time() + 3600
        if not await deliver_one():
            await asyncio.sleep(settings.email_worker_poll_seconds)


if __name__ == "__main__":
    asyncio.run(run())
