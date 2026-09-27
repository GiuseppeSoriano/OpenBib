"""Mailbox-first registration, bound to an opaque browser cookie.

All writes lock the normalized email BEFORE the challenge. This serializes
completion of distinct challenges as well as cookie rotation and resend races.
Invalid-code responses are returned, not raised, so attempt counts are committed.
"""

import hmac
import math
import secrets
import uuid
from datetime import UTC, timedelta

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.auth.email import queue_email, registration_email
from app.auth.models import RegistrationChallenge
from app.auth.router import _set_refresh_cookie, _token_response
from app.auth.schemas import (
    EmailRequest,
    RegistrationCompleteRequest,
    RegistrationStatus,
    RegistrationVerifyRequest,
    TokenResponse,
)
from app.auth.service import (
    create_session,
    hash_password,
    is_expired,
    lock_email_target,
    revoke_user_actions,
    revoke_user_sessions,
    token_digest,
    utcnow,
)
from app.common.crypto import keyring
from app.common.rate_limit import client_ip, enforce_rate_limit
from app.config import settings
from app.dependencies import DB
from app.legal import get_legal_config
from app.users.models import User

router = APIRouter(prefix="/auth/registration", tags=["registration"])


def cookie_name():
    return "__Host-openbib_registration" if settings.cookie_secure else "openbib_registration"


def _cookie(response, raw, expires_at):
    response.set_cookie(
        cookie_name(),
        raw,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
        max_age=max(0, math.ceil(_seconds(expires_at))),
    )


def _seconds(value):
    return (value.replace(tzinfo=UTC) - utcnow()).total_seconds()


def otp_digest(row, code):
    return keyring.digest(
        f"{row.id}:{row.generation}:{code}", purpose="registration-otp", version=row.key_version
    )


def stage(row):
    if row is None:
        return "email"
    if row.used_at is not None or is_expired(row.expires_at):
        return "expired"
    if row.attempts >= 5:
        return "locked"
    return "profile" if row.verified_at else "otp"


def status_data(row):
    current = stage(row)
    if row is None:
        return RegistrationStatus(stage=current)
    local, domain = row.email.rsplit("@", 1)
    return RegistrationStatus(
        stage=current,
        email_masked=f"{local[0]}***@{domain}",
        expires_at=row.expires_at.replace(tzinfo=UTC).isoformat(),
        otp_expires_at=row.otp_expires_at.replace(tzinfo=UTC).isoformat(),
        resend_after=max(0, math.ceil(_seconds(row.resend_at))),
    )


def denied(code="registration_expired", status=400):
    return JSONResponse(status_code=status, content={"detail": code})


async def _limit(request, response, scope, identity, limit, seconds):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope=scope,
        identity=identity,
        limit=limit,
        window_seconds=seconds,
        fail_closed=True,
    )


async def _send_limits(request, response, email):
    await _limit(request, response, "registration-send-ip", client_ip(request), 5, 3600)
    await _limit(request, response, "registration-send-email", f"email:{email}", 5, 3600)


async def _load(request, db, *, lock=False):
    raw = request.cookies.get(cookie_name(), "")
    if len(raw) != 43:
        return None
    query = select(RegistrationChallenge).where(
        RegistrationChallenge.cookie_digest == token_digest(raw)
    )
    row = (await db.execute(query)).scalar_one_or_none()
    if row is not None and lock:
        await lock_email_target(db, row.email)
        # Re-evaluate the digest after waiting: another request may have rotated it.
        row = (
            await db.execute(query.with_for_update().execution_options(populate_existing=True))
        ).scalar_one_or_none()
    return row


async def _issue(db, row, *, renew=False):
    code = f"{secrets.randbelow(1_000_000):06d}"
    if renew:
        # Even a random collision must not make the previous numeric code valid.
        # Compare against its old generation/key before advancing the generation.
        try:
            repeated = hmac.compare_digest(otp_digest(row, code), row.otp_digest)
        except ValueError:  # The old key was retired; its code cannot be checked.
            repeated = False
        if repeated:
            code = f"{(int(code) + 1 + secrets.randbelow(999_999)) % 1_000_000:06d}"
        row.generation += 1
    row.key_version = keyring.active_version
    row.otp_digest = otp_digest(row, code)
    now = utcnow()
    row.otp_expires_at = min(now + timedelta(minutes=10), row.expires_at.replace(tzinfo=UTC))
    row.resend_at = now + timedelta(seconds=60)
    user = (await db.execute(select(User).where(User.email == row.email))).scalar_one_or_none()
    # Decoy challenges have identical public state, but never send a code or
    # authorize a password replacement for an already verified account.
    if user is None or user.email_verified_at is None:
        subject, body, html = registration_email(row.locale, code, row.otp_expires_at)
        await queue_email(
            db,
            None,
            row.email,
            subject,
            body,
            html,
            registration={
                "id": str(row.id),
                "generation": row.generation,
                "expires_at": row.otp_expires_at.isoformat(),
            },
        )


@router.post("/start", response_model=RegistrationStatus, status_code=202)
async def start(body: EmailRequest, request: Request, response: Response, db: DB):
    email = str(body.email)
    await _send_limits(request, response, email)
    await lock_email_target(db, email)
    raw = secrets.token_urlsafe(32)
    now = utcnow()
    row = RegistrationChallenge(
        id=uuid.uuid4(),
        email=email,
        locale=body.locale,
        cookie_digest=token_digest(raw),
        otp_digest="",
        key_version=keyring.active_version,
        generation=1,
        attempts=0,
        expires_at=now + timedelta(minutes=30),
        otp_expires_at=now,
        resend_at=now,
    )
    db.add(row)
    # _issue queries users; autoflush must already see non-null columns.
    await _issue(db, row)
    await db.flush()
    _cookie(response, raw, row.expires_at)
    return status_data(row)


@router.get("/status", response_model=RegistrationStatus)
async def get_status(request: Request, db: DB):
    return status_data(await _load(request, db))


@router.post("/resend", response_model=RegistrationStatus, status_code=202)
async def resend(request: Request, response: Response, db: DB):
    row = await _load(request, db, lock=True)
    if stage(row) != "otp":
        return denied()
    await _send_limits(request, response, row.email)
    remaining = math.ceil(_seconds(row.resend_at))
    if remaining > 0:
        return JSONResponse(
            status_code=429,
            content={"detail": "registration_resend_wait"},
            headers={"Retry-After": str(remaining)},
        )
    await _issue(db, row, renew=True)
    await db.flush()
    return status_data(row)


@router.post("/verify", response_model=RegistrationStatus)
async def verify(body: RegistrationVerifyRequest, request: Request, response: Response, db: DB):
    await _limit(request, response, "registration-verify-ip", client_ip(request), 10, 600)
    row = await _load(request, db, lock=True)
    if stage(row) == "locked":
        return denied("registration_locked")
    if stage(row) != "otp":
        return denied()
    if is_expired(row.otp_expires_at):
        return denied("registration_code_expired")
    try:
        correct = hmac.compare_digest(otp_digest(row, body.code), row.otp_digest)
    except ValueError:  # A retired encryption-key version requires a fresh code.
        return denied("registration_code_expired")
    if not correct:
        row.attempts += 1
        await db.flush()
        return denied("registration_locked" if row.attempts >= 5 else "registration_code_invalid")
    user = (await db.execute(select(User).where(User.email == row.email))).scalar_one_or_none()
    if user is not None and user.email_verified_at is not None:
        row.used_at = utcnow()
        return denied()
    now = utcnow()
    row.verified_at = now
    row.expires_at = now + timedelta(minutes=15)
    row.otp_digest = ""  # The code is consumed; only the rotated browser grant can finish.
    raw = secrets.token_urlsafe(32)
    row.cookie_digest = token_digest(raw)
    await db.flush()
    _cookie(response, raw, row.expires_at)
    return status_data(row)


@router.post("/complete", response_model=TokenResponse)
async def complete(body: RegistrationCompleteRequest, request: Request, response: Response, db: DB):
    await _limit(request, response, "registration-complete-ip", client_ip(request), 10, 600)
    row = await _load(request, db, lock=True)
    if stage(row) != "profile":
        return denied()
    legal = get_legal_config()
    if body.terms_version != legal.terms_version or body.privacy_version != legal.privacy_version:
        return denied("registration_legal_changed", 409)
    user = (await db.execute(select(User).where(User.email == row.email))).scalar_one_or_none()
    if user is not None and user.email_verified_at is not None:
        row.used_at = utcnow()
        return denied("registration_unavailable", 409)
    now = utcnow()
    if user is None:
        user = User(email=row.email)
        db.add(user)
    user.display_name = body.display_name
    user.password_hash = hash_password(body.password)
    user.email_verified_at = now
    user.terms_accepted_at = user.privacy_acknowledged_at = now
    user.terms_version, user.privacy_version = legal.terms_version, legal.privacy_version
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="registration_unavailable") from None
    await revoke_user_actions(db, user.id)
    await revoke_user_sessions(db, user.id)
    await db.execute(
        update(RegistrationChallenge)
        .where(RegistrationChallenge.email == row.email, RegistrationChallenge.used_at.is_(None))
        .values(used_at=now)
    )
    session, raw = await create_session(db, user.id)
    _set_refresh_cookie(response, raw)
    response.delete_cookie(
        cookie_name(), path="/", httponly=True, secure=settings.cookie_secure, samesite="strict"
    )
    return _token_response(user, session.id)
