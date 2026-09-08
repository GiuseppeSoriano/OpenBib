"""Database, Redis, and authenticated-user dependencies."""

import uuid
from collections.abc import AsyncGenerator
from typing import Annotated

import redis.asyncio as aioredis
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory
from app.users.models import User

security_scheme = HTTPBearer(auto_error=False)


async def get_db() -> AsyncGenerator[AsyncSession]:
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_redis(request: Request) -> aioredis.Redis:
    return request.app.state.redis


async def _resolve_authenticated_user(
    credentials: HTTPAuthorizationCredentials | None,
    db: AsyncSession,
    request: Request | None = None,
):
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    from app.auth.service import active_session, verify_access_token
    from app.users.models import User

    payload = verify_access_token(credentials.credentials)
    if payload is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    try:
        user_id = uuid.UUID(payload["sub"])
        session_id = uuid.UUID(payload["sid"])
    except (ValueError, KeyError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        ) from None
    if request is not None and request.method not in ("GET", "HEAD", "OPTIONS"):
        from app.auth.service import lock_user

        await lock_user(db, user_id)
    user = await db.get(User, user_id, populate_existing=True)
    if user is None or await active_session(db, session_id, user_id) is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Session is no longer active"
        )
    if request is not None:
        request.state.actor_id = str(user.id)
    return user


async def get_authenticated_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security_scheme)],
    db: Annotated[AsyncSession, Depends(get_db, scope="function")],
    request: Request,
):
    return await _resolve_authenticated_user(credentials, db, request)


async def get_current_user(user: Annotated["User", Depends(get_authenticated_user)]):
    from app.auth.service import legal_acceptance_required

    if user.email_verified_at is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Email verification required"
        )
    if legal_acceptance_required(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Legal acceptance required"
        )
    return user


async def get_optional_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security_scheme)],
    db: Annotated[AsyncSession, Depends(get_db, scope="function")],
    request: Request,
):
    if credentials is None:
        return None
    try:
        user = await _resolve_authenticated_user(credentials, db, request)
        from app.auth.service import legal_acceptance_required

        return (
            user
            if user.email_verified_at is not None and not legal_acceptance_required(user)
            else None
        )
    except HTTPException:
        return None


DB = Annotated[AsyncSession, Depends(get_db, scope="function")]
Redis = Annotated[aioredis.Redis, Depends(get_redis)]
AuthenticatedUser = Annotated["User", Depends(get_authenticated_user)]
CurrentUser = Annotated["User", Depends(get_current_user)]
OptionalUser = Annotated["User | None", Depends(get_optional_user)]
