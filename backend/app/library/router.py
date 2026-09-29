"""Library router — persistent personal archive endpoints."""

import uuid
from typing import Literal

from fastapi import APIRouter, Query, Request, Response

from app.common.rate_limit import enforce_rate_limit
from app.dependencies import DB, CurrentUser, Redis
from app.library import service
from app.library.schemas import (
    LibraryEntryEnsure,
    LibraryEntryPage,
    LibraryEntryRead,
    LibraryEntryRepin,
    LibraryFacets,
    LibraryResolve,
    LibraryResolveRead,
    LibraryVersionAdd,
    LibraryVersionPin,
)
from app.papers.models import READING_STATES
from app.papers.service import get_cached_paper

router = APIRouter(prefix="/library", tags=["library"])


@router.get("/entries", response_model=LibraryEntryPage)
async def list_entries(
    user: CurrentUser,
    db: DB,
    q: str | None = Query(None, max_length=200),
    state: Literal[READING_STATES] | None = None,
    tag: str | None = Query(None, min_length=1, max_length=100),
    collection_id: uuid.UUID | None = None,
    sort: Literal["added", "title", "year", "citations"] = "added",
    page: int = Query(1, ge=1),
    size: int = Query(25, ge=1, le=100),
):
    """``q`` matches title, venue and author names. ``state`` and ``tag``
    keep entries with a pinned version in that reading state or carrying that
    tag. 404 when ``collection_id`` is not a collection you can view."""
    items, total = await service.list_entries(
        db,
        user.id,
        q=q,
        state=state,
        tag=tag,
        collection_id=collection_id,
        sort=sort,
        page=page,
        size=size,
    )
    return {"items": items, "total": total, "page": page, "size": size}


@router.get("/facets", response_model=LibraryFacets)
async def get_facets(user: CurrentUser, db: DB):
    """Tags and reading states with their entry counts, plus the Library
    total and how many entries still lack metadata."""
    return await service.library_facets(db, user.id)


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
    """Save a paper to the Library. Cached metadata is authoritative for the
    group: a client-supplied group that disagrees with it is ignored, and the
    entry that actually holds the paper is returned."""
    cached = await get_cached_paper(db, body.paper_canonical_key)
    entry, _ = await service.ensure_entry_and_version(
        db,
        user.id,
        cached.paper_group_key if cached is not None else body.paper_group_key,
        body.paper_canonical_key,
        body.source_provider,
        authoritative_group=cached is not None,
    )
    return await service.get_entry(db, user.id, entry.paper_group_key)


@router.post("/resolve", response_model=LibraryResolveRead)
async def resolve_paper(
    body: LibraryResolve,
    request: Request,
    response: Response,
    user: CurrentUser,
    db: DB,
    redis: Redis,
):
    """Retry resolving a paper stored in your Library or in a collection you
    can edit, or correct its identifier with ``replacement`` (same forms as
    adding a paper).

    ``resolved``: the paper is stored under its canonical key and real Library
    group, merged with any row already there. ``unavailable``: providers did
    not answer; a legacy key still moves to its normalized ``doi:`` form.
    ``not_found``: nothing changed. Only your own rows and rows in collections
    you can edit are re-keyed. Errors: 404 ``not_in_library``; 422
    ``invalid_identifier``.
    """
    await enforce_rate_limit(
        redis,
        request,
        response,
        scope="paper-resolve",
        identity=f"user:{user.id}",
        limit=30,
        window_seconds=60,
        fail_closed=True,
    )
    return await service.resolve_library_paper(
        db, user.id, body.paper_canonical_key, body.replacement
    )


@router.patch("/entries/{paper_group_key:path}", response_model=LibraryEntryRead)
async def repin_primary(
    paper_group_key: str,
    body: LibraryEntryRepin,
    user: CurrentUser,
    db: DB,
):
    await service.repin_primary(db, user.id, paper_group_key, body.primary_canonical_key)
    return await service.get_entry(db, user.id, paper_group_key)


# Declared before the greedy DELETE /entries/{paper_group_key:path} below,
# which would otherwise swallow this route.
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
    await service.remove_version(db, user.id, paper_group_key, paper_canonical_key)


@router.delete("/entries/{paper_group_key:path}", status_code=204)
async def delete_entry(
    paper_group_key: str,
    user: CurrentUser,
    db: DB,
    detach: bool = Query(False),
):
    """409 ``entry_in_collections`` (with the collections) while a pinned
    version is still in one of your collections; ``detach=true`` removes it
    from them first."""
    await service.delete_entry(db, user.id, paper_group_key, detach=detach)


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
