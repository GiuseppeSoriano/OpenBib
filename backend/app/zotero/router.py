"""Zotero router — credentials management + one-way sync."""

import uuid

from fastapi import APIRouter, HTTPException, Request, Response, status

from app.common.rate_limit import enforce_rate_limit
from app.dependencies import DB, CurrentUser
from app.zotero import service
from app.zotero.client import ZoteroAuthError, ZoteroError
from app.zotero.schemas import (
    ZoteroCredentialsStatus,
    ZoteroCredentialsUpdate,
    ZoteroSyncReport,
)

router = APIRouter(prefix="/zotero", tags=["zotero"])


@router.get("/credentials", response_model=ZoteroCredentialsStatus)
async def get_credentials_status(user: CurrentUser, db: DB):
    return await service.credentials_status(db, user.id)


@router.put("/credentials", response_model=ZoteroCredentialsStatus)
async def set_credentials(
    body: ZoteroCredentialsUpdate, request: Request, response: Response, user: CurrentUser, db: DB
):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="zotero-connect",
        identity=f"user:{user.id}",
        limit=10,
        window_seconds=3600,
        fail_closed=True,
    )
    try:
        return await service.set_credentials(db, user.id, body.api_key)
    except ZoteroAuthError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Zotero API key"
        ) from None
    except ZoteroError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="Zotero request failed"
        ) from None


@router.delete("/credentials", status_code=204)
async def delete_credentials(user: CurrentUser, db: DB):
    await service.delete_credentials(db, user.id)


@router.post("/sync/collection/{collection_id}", response_model=ZoteroSyncReport)
async def sync_collection(
    collection_id: uuid.UUID, request: Request, response: Response, user: CurrentUser, db: DB
):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="zotero-sync",
        identity=f"user:{user.id}",
        limit=10,
        window_seconds=3600,
        fail_closed=True,
    )
    return await service.sync_collection(db, user.id, collection_id)


@router.post("/sync/library", response_model=ZoteroSyncReport)
async def sync_library(request: Request, response: Response, user: CurrentUser, db: DB):
    await enforce_rate_limit(
        request.app.state.redis,
        request,
        response,
        scope="zotero-sync",
        identity=f"user:{user.id}",
        limit=10,
        window_seconds=3600,
        fail_closed=True,
    )
    return await service.sync_library(db, user.id)
