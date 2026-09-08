"""User profile, legal acceptance, portability, and deletion routes."""

from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.auth.email import lifecycle_email, queue_email
from app.auth.schemas import EmailChangeRequest, LegalAcceptanceRequest, PasswordChangeRequest
from app.auth.service import (
    create_action_token,
    hash_password,
    legal_acceptance_required,
    revoke_user_actions,
    revoke_user_sessions,
    utcnow,
    verify_password,
)
from app.common.rate_limit import enforce_rate_limit
from app.config import settings
from app.dependencies import DB, AuthenticatedUser, CurrentUser
from app.legal import get_legal_config
from app.users.models import User
from app.users.schemas import DeleteAccountRequest, ReauthenticatedRequest, UserRead, UserUpdate
from app.users.service import delete_user_account, export_user_data

router = APIRouter(prefix="/users", tags=["users"])


async def _reauth_limit(request: Request, response: Response, user: User):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="reauth",
        identity=f"user:{user.id}",
        limit=10,
        window_seconds=600,
        fail_closed=True,
    )


def _read_user(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "created_at": user.created_at,
        "email_verified": user.email_verified_at is not None,
        "legal_acceptance_required": legal_acceptance_required(user),
    }


def _clear_refresh_cookie(response: Response) -> None:
    name = "__Host-openbib_refresh" if settings.cookie_secure else "openbib_refresh"
    response.delete_cookie(
        name, httponly=True, secure=settings.cookie_secure, samesite="strict", path="/"
    )


@router.get("/me", response_model=UserRead)
async def get_me(user: AuthenticatedUser):
    return _read_user(user)


@router.get("/me/stats")
async def get_stats(user: CurrentUser, db: DB):
    from app.collections.service import get_user_stats

    return await get_user_stats(db, user.id)


@router.patch("/me", response_model=UserRead)
async def update_me(body: UserUpdate, user: CurrentUser, db: DB):
    if body.display_name is not None:
        user.display_name = body.display_name.strip()
    db.add(user)
    await db.flush()
    return _read_user(user)


@router.post("/me/legal-acceptance", response_model=UserRead)
async def accept_legal_documents(body: LegalAcceptanceRequest, user: AuthenticatedUser, db: DB):
    legal = get_legal_config()
    if body.terms_version != legal.terms_version or body.privacy_version != legal.privacy_version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Legal documents changed; reload the current versions",
        )
    now = utcnow()
    user.terms_accepted_at = now
    user.terms_version = legal.terms_version
    user.privacy_acknowledged_at = now
    user.privacy_version = legal.privacy_version
    await db.flush()
    return _read_user(user)


@router.post("/me/email-change", status_code=status.HTTP_202_ACCEPTED)
async def request_email_change(
    body: EmailChangeRequest, user: AuthenticatedUser, request: Request, response: Response, db: DB
):
    await _reauth_limit(request, response, user)
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid password")
    email = str(body.email)
    existing = await db.execute(select(User).where(User.email == email, User.id != user.id))
    if existing.scalar_one_or_none() is not None:
        return {"message": "If the request is valid, further instructions will be sent."}
    raw = await create_action_token(db, user.id, "change_email", timedelta(hours=24), email)
    subject, content = lifecycle_email("change_email", body.locale, raw)
    await queue_email(db, user.id, email, subject, content)
    return {"message": "If the request is valid, further instructions will be sent."}


@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: PasswordChangeRequest,
    user: AuthenticatedUser,
    response: Response,
    request: Request,
    db: DB,
):
    await _reauth_limit(request, response, user)
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid password")
    if verify_password(body.new_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="New password must be different",
        )
    user.password_hash = hash_password(body.new_password)
    await revoke_user_actions(db, user.id)
    await revoke_user_sessions(db, user.id)
    _clear_refresh_cookie(response)


@router.post("/me/export")
async def export_me(
    body: ReauthenticatedRequest,
    user: AuthenticatedUser,
    request: Request,
    response: Response,
    db: DB,
):
    await _reauth_limit(request, response, user)
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid password")
    content = jsonable_encoder(await export_user_data(db, user))
    return JSONResponse(
        content=content,
        headers={
            "Content-Disposition": f'attachment; filename="openbib-export-{user.id}.json"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/me/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_me(
    body: DeleteAccountRequest,
    user: AuthenticatedUser,
    response: Response,
    request: Request,
    db: DB,
):
    await _reauth_limit(request, response, user)
    if body.confirmation != "DELETE":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Type DELETE to confirm"
        )
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid password")
    await revoke_user_sessions(db, user.id)
    await delete_user_account(db, user)
    _clear_refresh_cookie(response)
