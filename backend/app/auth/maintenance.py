"""Bound security data retention; called periodically by the email worker."""

from datetime import timedelta
from pathlib import Path

from sqlalchemy import delete

from app.auth.models import AccountDeletionTombstone, AuthSession, EmailOutbox, UserActionToken
from app.auth.service import utcnow
from app.config import settings
from app.database import async_session_factory


async def cleanup_expired_data():
    now = utcnow()
    async with async_session_factory() as db:
        await db.execute(delete(AuthSession).where(AuthSession.expires_at < now))
        await db.execute(delete(UserActionToken).where(UserActionToken.expires_at < now))
        await db.execute(
            delete(EmailOutbox).where(EmailOutbox.created_at < now - timedelta(days=7))
        )
        await db.execute(
            delete(AccountDeletionTombstone).where(AccountDeletionTombstone.expires_at < now)
        )
        await db.commit()
    if settings.environment == "production":
        for category, days in (("access", 14), ("security", 90)):
            for path in Path(settings.log_directory).glob(f"openbib.{category}.jsonl.*"):
                if (
                    path.is_file()
                    and path.stat().st_mtime < (now - timedelta(days=days)).timestamp()
                ):
                    path.unlink()
