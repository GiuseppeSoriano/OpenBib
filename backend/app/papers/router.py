"""Papers router — lookup, search, states, tags."""

import logging

from fastapi import APIRouter, HTTPException, Query

from app.dependencies import DB, CurrentUser, Redis
from app.papers import service
from app.papers.schemas import (
    PaperMetadataRead,
    SearchQuery,
    StateRead,
    StateUpdate,
    TagCreate,
    TagRead,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/papers", tags=["papers"])


@router.get("/search")
async def search_papers(
    q: str = Query(min_length=1, max_length=500),
    provider: str | None = None,
    year_from: int | None = None,
    year_to: int | None = None,
    author: str | None = None,
    open_access_only: bool = False,
    page: int = Query(1, ge=1),
    size: int = Query(25, ge=1, le=100),
    redis: Redis = None,
):
    from dataclasses import asdict
    from app.providers.registry import search as provider_search
    from app.providers.base import SearchFilters

    filters = SearchFilters(
        year_from=year_from,
        year_to=year_to,
        author=author,
        open_access_only=open_access_only,
    )
    try:
        result = await provider_search(
            query=q,
            filters=filters,
            page=page,
            size=size,
            provider_name=provider or "openalex",
        )
    except Exception as exc:
        logger.warning("Search provider error for q=%r: %s", q, exc)
        raise HTTPException(
            status_code=502,
            detail="The external search provider is temporarily unavailable. Please try again.",
        ) from exc
    return asdict(result)


# ── Dismiss (must be before {paper_key:path} routes) ────────

@router.get("/dismissed")
async def get_dismissed(user: CurrentUser, db: DB):
    keys = await service.get_dismissed_keys(db, user.id)
    return keys


@router.get("/{paper_key:path}/states", response_model=list[StateRead])
async def get_states(paper_key: str, user: CurrentUser, db: DB):
    return await service.get_paper_states(db, user.id, paper_key)


@router.put("/{paper_key:path}/state", response_model=StateRead)
async def set_state(paper_key: str, body: StateUpdate, user: CurrentUser, db: DB):
    return await service.set_paper_state(db, user.id, paper_key, body.state, body.collection_id)


@router.get("/{paper_key:path}/tags", response_model=list[TagRead])
async def get_tags(paper_key: str, user: CurrentUser, db: DB):
    return await service.get_tags(db, user.id, paper_key)


@router.post("/{paper_key:path}/tags", response_model=TagRead, status_code=201)
async def add_tag(paper_key: str, body: TagCreate, user: CurrentUser, db: DB):
    return await service.add_tag(db, user.id, paper_key, body.tag)


@router.delete("/{paper_key:path}/tags/{tag}", status_code=204)
async def remove_tag(paper_key: str, tag: str, user: CurrentUser, db: DB):
    await service.remove_tag(db, user.id, paper_key, tag)


@router.post("/{paper_key:path}/dismiss", status_code=201)
async def dismiss_paper(paper_key: str, user: CurrentUser, db: DB):
    dp = await service.dismiss_paper(db, user.id, paper_key)
    return {"paper_canonical_key": dp.paper_canonical_key, "dismissed_at": dp.dismissed_at}


@router.delete("/{paper_key:path}/dismiss", status_code=204)
async def undismiss_paper(paper_key: str, user: CurrentUser, db: DB):
    await service.undismiss_paper(db, user.id, paper_key)
