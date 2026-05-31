"""Library router — persistent personal archive endpoints."""

from fastapi import APIRouter, Query

from app.dependencies import DB, CurrentUser
from app.library import service
from app.library.schemas import (
    LibraryEntryEnsure,
    LibraryEntryListItem,
    LibraryEntryRead,
    LibraryEntryRepin,
    LibraryVersionAdd,
    LibraryVersionPin,
)

router = APIRouter(prefix="/library", tags=["library"])


@router.get("/entries", response_model=list[LibraryEntryListItem])
async def list_entries(
    user: CurrentUser,
    db: DB,
    page: int = Query(1, ge=1),
    size: int = Query(25, ge=1, le=100),
):
    return await service.list_entries(db, user.id, page=page, size=size)


@router.get("/keys", response_model=list[str])
async def list_keys(user: CurrentUser, db: DB):
    """Flat list of paper_group_keys in the user's library — used by the
    search page to render a 'Saved to Library' badge."""
    return await service.list_group_keys(db, user.id)


@router.get("/entries/{paper_group_key:path}", response_model=LibraryEntryRead)
async def get_entry(paper_group_key: str, user: CurrentUser, db: DB):
    return await service.get_entry(db, user.id, paper_group_key)


@router.post("/entries", response_model=LibraryEntryRead, status_code=201)
async def ensure_entry(body: LibraryEntryEnsure, user: CurrentUser, db: DB):
    await service.ensure_entry_and_version(
        db,
        user.id,
        body.paper_group_key,
        body.paper_canonical_key,
        body.source_provider,
    )
    return await service.get_entry(db, user.id, body.paper_group_key)


@router.patch("/entries/{paper_group_key:path}", response_model=LibraryEntryRead)
async def repin_primary(
    paper_group_key: str,
    body: LibraryEntryRepin,
    user: CurrentUser,
    db: DB,
):
    await service.repin_primary(
        db, user.id, paper_group_key, body.primary_canonical_key
    )
    return await service.get_entry(db, user.id, paper_group_key)


@router.delete("/entries/{paper_group_key:path}", status_code=204)
async def delete_entry(paper_group_key: str, user: CurrentUser, db: DB):
    await service.delete_entry(db, user.id, paper_group_key)


@router.post(
    "/entries/{paper_group_key:path}/versions",
    response_model=LibraryVersionPin,
    status_code=201,
)
async def add_version(
    paper_group_key: str,
    body: LibraryVersionAdd,
    user: CurrentUser,
    db: DB,
):
    return await service.add_version(
        db,
        user.id,
        paper_group_key,
        body.paper_canonical_key,
        body.source_provider,
    )


@router.delete(
    "/entries/{paper_group_key}/versions/{paper_canonical_key:path}",
    status_code=204,
)
async def remove_version(
    paper_group_key: str,
    paper_canonical_key: str,
    user: CurrentUser,
    db: DB,
):
    await service.remove_version(
        db, user.id, paper_group_key, paper_canonical_key
    )
