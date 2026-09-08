"""Authentication router with verified email and revocable opaque sessions."""

from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.auth.email import lifecycle_email, queue_email
from app.auth.schemas import (
    EmailRequest,
    LoginRequest,
    MessageResponse,
    PasswordResetRequest,
    RegisterRequest,
    TokenRequest,
    TokenResponse,
    VerifyEmailRequest,
)
from app.auth.service import (
    consume_action_token,
    create_access_token,
    create_action_token,
    create_session,
    hash_password,
    legal_acceptance_required,
    lock_email_target,
    maybe_rehash_password,
    revoke_session_token,
    revoke_user_actions,
    revoke_user_sessions,
    rotate_session,
    utcnow,
    verify_password,
)
from app.common.rate_limit import client_ip, enforce_rate_limit
from app.config import settings
from app.dependencies import DB, AuthenticatedUser
from app.legal import get_legal_config
from app.users.models import User

router = APIRouter(prefix="/auth", tags=["auth"])


def _cookie_name() -> str:
    return "__Host-openbib_refresh" if settings.cookie_secure else "openbib_refresh"


def _set_refresh_cookie(response: Response, token: str, expires_at=None) -> None:
    remaining = (
        max(0, int((expires_at.replace(tzinfo=utcnow().tzinfo) - utcnow()).total_seconds()))
        if expires_at
        else settings.jwt_refresh_token_expire_days * 86400
    )
    response.set_cookie(
        _cookie_name(),
        token,
        max_age=remaining,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        _cookie_name(), httponly=True, secure=settings.cookie_secure, samesite="strict", path="/"
    )


def _token_response(user: User, session_id) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(user.id, session_id),
        expires_in=settings.jwt_access_token_expire_minutes * 60,
        legal_acceptance_required=legal_acceptance_required(user),
    )


async def _queue_action(
    db: DB, user: User, purpose: str, locale: str, recipient: str, ttl: timedelta
) -> None:
    raw = await create_action_token(
        db, user.id, purpose, ttl, recipient if purpose == "change_email" else None
    )
    subject, body = lifecycle_email(purpose, locale, raw)
    await queue_email(db, user.id, recipient, subject, body)


@router.post("/register", response_model=MessageResponse, status_code=status.HTTP_202_ACCEPTED)
async def register(body: RegisterRequest, request: Request, response: Response, db: DB):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="register-ip",
        identity=client_ip(request),
        limit=5,
        window_seconds=3600,
        fail_closed=True,
    )
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="register-email",
        identity=f"email:{body.email}",
        limit=5,
        window_seconds=3600,
        fail_closed=True,
    )
    legal = get_legal_config()
    if body.terms_version != legal.terms_version or body.privacy_version != legal.privacy_version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Legal documents changed; reload and accept the current versions",
        )
    await lock_email_target(db, str(body.email))
    result = await db.execute(select(User).where(User.email == str(body.email)))
    user = result.scalar_one_or_none()
    if user is None:
        now = utcnow()
        user = User(
            email=str(body.email),
            password_hash=hash_password(body.password),
            display_name=body.display_name.strip(),
            terms_accepted_at=now,
            terms_version=legal.terms_version,
            privacy_acknowledged_at=now,
            privacy_version=legal.privacy_version,
        )
        db.add(user)
        try:
            await db.flush()
        except IntegrityError:
            await db.rollback()
            return MessageResponse()
    else:
        verify_password(body.password, None)
        return MessageResponse()
    await _queue_action(db, user, "verify_email", body.locale, user.email, timedelta(hours=24))
    return MessageResponse()


@router.post("/verify-email", response_model=TokenResponse)
async def verify_email(body: VerifyEmailRequest, request: Request, response: Response, db: DB):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="verify-email",
        identity=client_ip(request),
        limit=10,
        window_seconds=600,
        fail_closed=True,
    )
    action = await consume_action_token(db, body.token, "verify_email")
    if action is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired verification token"
        )
    user = await db.get(User, action.user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired verification token"
        )
    user.password_hash = hash_password(body.new_password)
    user.email_verified_at = utcnow()
    await revoke_user_actions(db, user.id)
    await revoke_user_sessions(db, user.id)
    session, raw = await create_session(db, user.id)
    _set_refresh_cookie(response, raw)
    return _token_response(user, session.id)


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, request: Request, response: Response, db: DB):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="login-ip",
        identity=client_ip(request),
        limit=10,
        window_seconds=600,
        fail_closed=True,
    )
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="login-email",
        identity=f"email:{body.email}",
        limit=10,
        window_seconds=600,
        fail_closed=True,
    )
    result = await db.execute(select(User).where(User.email == str(body.email)).with_for_update())
    user = result.scalar_one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        if user is None:
            verify_password(body.password, None)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password"
        )
    if user.email_verified_at is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Email verification required"
        )
    maybe_rehash_password(user, body.password)
    session, raw = await create_session(db, user.id)
    _set_refresh_cookie(response, raw)
    return _token_response(user, session.id)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(request: Request, response: Response, db: DB):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="refresh",
        identity=client_ip(request),
        limit=30,
        window_seconds=300,
        fail_closed=True,
    )
    raw = request.cookies.get(_cookie_name())
    rotated = await rotate_session(db, raw) if raw else None
    if rotated is None:
        # Return a response, not an exception: the transaction must persist replay revocation.
        denied = JSONResponse(status_code=401, content={"detail": "Invalid refresh session"})
        _clear_refresh_cookie(denied)
        return denied
    session, replacement = rotated
    user = await db.get(User, session.user_id)
    if user is None:
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh session"
        )
    _set_refresh_cookie(response, replacement, session.expires_at)
    return _token_response(user, session.id)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, db: DB):
    await revoke_session_token(db, request.cookies.get(_cookie_name()))
    _clear_refresh_cookie(response)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
async def logout_all(user: AuthenticatedUser, response: Response, db: DB):
    await revoke_user_actions(db, user.id)
    await revoke_user_sessions(db, user.id)
    _clear_refresh_cookie(response)


@router.post("/email/resend", response_model=MessageResponse, status_code=status.HTTP_202_ACCEPTED)
async def resend_verification(body: EmailRequest, request: Request, response: Response, db: DB):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="resend-ip",
        identity=client_ip(request),
        limit=5,
        window_seconds=3600,
        fail_closed=True,
    )
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="resend-email",
        identity=f"email:{body.email}",
        limit=5,
        window_seconds=3600,
        fail_closed=True,
    )
    user = (
        await db.execute(select(User).where(User.email == str(body.email)))
    ).scalar_one_or_none()
    if user is not None and user.email_verified_at is None:
        await _queue_action(db, user, "verify_email", body.locale, user.email, timedelta(hours=24))
    return MessageResponse()


@router.post(
    "/password/forgot", response_model=MessageResponse, status_code=status.HTTP_202_ACCEPTED
)
async def forgot_password(body: EmailRequest, request: Request, response: Response, db: DB):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="forgot-ip",
        identity=client_ip(request),
        limit=5,
        window_seconds=3600,
        fail_closed=True,
    )
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="forgot-email",
        identity=f"email:{body.email}",
        limit=5,
        window_seconds=3600,
        fail_closed=True,
    )
    user = (
        await db.execute(select(User).where(User.email == str(body.email)))
    ).scalar_one_or_none()
    if user is not None and user.email_verified_at is not None:
        await _queue_action(db, user, "reset_password", body.locale, user.email, timedelta(hours=1))
    return MessageResponse()


@router.post("/password/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(body: PasswordResetRequest, request: Request, response: Response, db: DB):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="reset",
        identity=client_ip(request),
        limit=10,
        window_seconds=600,
        fail_closed=True,
    )
    action = await consume_action_token(db, body.token, "reset_password")
    if action is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset token"
        )
    user = await db.get(User, action.user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset token"
        )
    user.password_hash = hash_password(body.new_password)
    await revoke_user_actions(db, user.id)
    await revoke_user_sessions(db, user.id)
    _clear_refresh_cookie(response)


@router.post("/email/confirm", status_code=status.HTTP_204_NO_CONTENT)
async def confirm_email_change(body: TokenRequest, request: Request, response: Response, db: DB):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="confirm-email",
        identity=client_ip(request),
        limit=10,
        window_seconds=600,
        fail_closed=True,
    )
    action = await consume_action_token(db, body.token, "change_email")
    if action is None or action.email_target is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired email-change token"
        )
    await lock_email_target(db, action.email_target)
    existing = await db.execute(
        select(User).where(User.email == action.email_target, User.id != action.user_id)
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Email address is no longer available"
        )
    user = await db.get(User, action.user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired email-change token"
        )
    user.email = action.email_target
    user.email_verified_at = utcnow()
    await revoke_user_actions(db, user.id)
    await revoke_user_sessions(db, user.id)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="Email address is no longer available"
        ) from None
    _clear_refresh_cookie(response)
