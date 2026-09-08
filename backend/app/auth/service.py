"""Password hashing, short-lived JWTs, opaque refresh sessions, and action tokens."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import AuthSession, UserActionToken
from app.config import settings
from app.legal import get_legal_config
from app.users.models import User

_ph = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)
_dummy_hash = _ph.hash("openbib-constant-time-dummy-password")


def utcnow() -> datetime:
    return datetime.now(UTC)


def is_expired(value: datetime) -> bool:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value <= utcnow()


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    candidate = password_hash or _dummy_hash
    try:
        valid = _ph.verify(candidate, password)
    except (VerificationError, InvalidHashError):
        return False
    return bool(password_hash) and valid


def maybe_rehash_password(user: User, password: str) -> None:
    if _ph.check_needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def legal_acceptance_required(user: User) -> bool:
    legal = get_legal_config()
    return (
        user.terms_version != legal.terms_version or user.privacy_version != legal.privacy_version
    )


def create_access_token(user_id: uuid.UUID, session_id: uuid.UUID) -> str:
    now = utcnow()
    expire = now + timedelta(minutes=settings.jwt_access_token_expire_minutes)
    payload = {
        "sub": str(user_id),
        "sid": str(session_id),
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": expire,
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "type": "access",
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def verify_access_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
            options={"require": ["sub", "sid", "jti", "iat", "exp", "iss", "aud", "type"]},
        )
        return payload if payload.get("type") == "access" else None
    except jwt.PyJWTError:
        return None


async def lock_user(db: AsyncSession, user_id: uuid.UUID) -> None:
    """Serialize credential changes, session creation/rotation, and revocation per account."""
    await db.execute(select(User.id).where(User.id == user_id).with_for_update())


async def lock_email_target(db: AsyncSession, email: str) -> None:
    """Serialize PostgreSQL transactions that claim the same normalized email address."""
    if db.get_bind().dialect.name != "postgresql":
        return
    key = int.from_bytes(hashlib.sha256(email.encode()).digest()[:8], "big", signed=True)
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})


async def create_session(
    db: AsyncSession, user_id: uuid.UUID, family_id: uuid.UUID | None = None
) -> tuple[AuthSession, str]:
    await lock_user(db, user_id)
    raw = secrets.token_urlsafe(32)
    session = AuthSession(
        family_id=family_id or uuid.uuid4(),
        user_id=user_id,
        token_digest=token_digest(raw),
        expires_at=utcnow() + timedelta(days=settings.jwt_refresh_token_expire_days),
    )
    db.add(session)
    await db.flush()
    return session, raw


async def rotate_session(db: AsyncSession, raw_token: str) -> tuple[AuthSession, str] | None:
    user_id = (
        await db.execute(
            select(AuthSession.user_id).where(AuthSession.token_digest == token_digest(raw_token))
        )
    ).scalar_one_or_none()
    if user_id is None:
        return None
    await lock_user(db, user_id)
    result = await db.execute(
        select(AuthSession)
        .where(AuthSession.token_digest == token_digest(raw_token))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    current = result.scalar_one_or_none()
    if current is None:
        return None
    if (
        current.revoked_at is not None
        or current.replaced_by_id is not None
        or is_expired(current.expires_at)
    ):
        await revoke_family(db, current.family_id)
        return None
    replacement, raw = await create_session(db, current.user_id, current.family_id)
    replacement.expires_at = current.expires_at
    current.last_used_at = utcnow()
    current.replaced_by_id = replacement.id
    await db.flush()
    return replacement, raw


async def revoke_family(db: AsyncSession, family_id: uuid.UUID) -> None:
    user_id = (
        await db.execute(
            select(AuthSession.user_id).where(AuthSession.family_id == family_id).limit(1)
        )
    ).scalar_one_or_none()
    if user_id is None:
        return
    await lock_user(db, user_id)
    await db.execute(
        update(AuthSession)
        .where(AuthSession.family_id == family_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=utcnow())
        .execution_options(synchronize_session="fetch")
    )


async def revoke_session_token(db: AsyncSession, raw_token: str | None) -> None:
    if not raw_token:
        return
    result = await db.execute(
        select(AuthSession).where(AuthSession.token_digest == token_digest(raw_token))
    )
    session = result.scalar_one_or_none()
    if session is not None:
        await revoke_family(db, session.family_id)


async def revoke_user_sessions(db: AsyncSession, user_id: uuid.UUID) -> None:
    await lock_user(db, user_id)
    await db.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=utcnow())
        .execution_options(synchronize_session="fetch")
    )


async def revoke_user_actions(db: AsyncSession, user_id: uuid.UUID) -> None:
    await lock_user(db, user_id)
    await db.execute(
        update(UserActionToken)
        .where(UserActionToken.user_id == user_id, UserActionToken.used_at.is_(None))
        .values(used_at=utcnow())
        .execution_options(synchronize_session="fetch")
    )


async def active_session(
    db: AsyncSession, session_id: uuid.UUID, user_id: uuid.UUID
) -> AuthSession | None:
    session = await db.get(AuthSession, session_id, populate_existing=True)
    if (
        session is None
        or session.user_id != user_id
        or session.revoked_at is not None
        or is_expired(session.expires_at)
    ):
        return None
    return session


async def create_action_token(
    db: AsyncSession,
    user_id: uuid.UUID,
    purpose: str,
    ttl: timedelta,
    email_target: str | None = None,
) -> str:
    await lock_user(db, user_id)
    now = utcnow()
    await db.execute(
        update(UserActionToken)
        .where(
            UserActionToken.user_id == user_id,
            UserActionToken.purpose == purpose,
            UserActionToken.used_at.is_(None),
        )
        .values(used_at=now)
    )
    raw = secrets.token_urlsafe(32)
    db.add(
        UserActionToken(
            user_id=user_id,
            purpose=purpose,
            token_digest=token_digest(raw),
            email_target=email_target,
            expires_at=now + ttl,
        )
    )
    await db.flush()
    return raw


async def consume_action_token(db: AsyncSession, raw: str, purpose: str) -> UserActionToken | None:
    user_id = (
        await db.execute(
            select(UserActionToken.user_id).where(
                UserActionToken.token_digest == token_digest(raw),
                UserActionToken.purpose == purpose,
            )
        )
    ).scalar_one_or_none()
    if user_id is None:
        return None
    await lock_user(db, user_id)
    result = await db.execute(
        select(UserActionToken)
        .where(
            UserActionToken.token_digest == token_digest(raw), UserActionToken.purpose == purpose
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    action = result.scalar_one_or_none()
    if action is None or action.used_at is not None or is_expired(action.expires_at):
        return None
    action.used_at = utcnow()
    await db.flush()
    return action
