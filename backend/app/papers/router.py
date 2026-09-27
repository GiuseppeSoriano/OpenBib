"""Papers router — lookup, search, states, tags."""

import json
import logging

from fastapi import APIRouter, Query, Request, Response

from app.common.rate_limit import client_ip, enforce_rate_limit
from app.dependencies import DB, CurrentUser, Redis
from app.papers import service
from app.papers.schemas import (
    PaperDetailRead,
    SearchResultRead,
    StateRead,
    StateUpdate,
    TagCreate,
    TagRead,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/papers", tags=["papers"])


@router.get("/search", response_model=SearchResultRead)
async def search_papers(
    q: str = Query(min_length=1, max_length=500),
    providers: list[str] | None = Query(None, max_length=20),
    year_from: int | None = None,
    year_to: int | None = None,
    author: str | None = Query(None, max_length=200),
    open_access_only: bool = False,
    page: int = Query(1, ge=1),
    size: int = Query(25, ge=1, le=100),
    request: Request = None,
    response: Response = None,
    db: DB = None,
    redis: Redis = None,
):
    await enforce_rate_limit(
        redis,
        request,
        response,
        scope="search",
        identity=client_ip(request),
        limit=30,
        window_seconds=60,
        fail_closed=True,
    )
    from app.providers.base import SearchFilters
    from app.providers.cache import cache_get, cache_set
    from app.providers.registry import CACHE_NAMESPACE, search_all, selected_provider_names

    providers = selected_provider_names(providers)

    # One cache entry per full fan-out query: repeat searches within
    # cache_ttl_search are served from Redis without touching providers.
    cache_id = json.dumps(
        {
            "q": q,
            "providers": sorted(providers) if providers else None,
            "year_from": year_from,
            "year_to": year_to,
            "author": author,
            "open_access_only": open_access_only,
            "page": page,
            "size": size,
        },
        sort_keys=True,
    )
    try:
        cached = await cache_get(redis, CACHE_NAMESPACE, "search", cache_id)
    except Exception:  # Redis down → bypass the cache, never fail the search
        cached = None
    if cached is not None:
        return cached

    filters = SearchFilters(
        year_from=year_from,
        year_to=year_to,
        author=author,
        open_access_only=open_access_only,
    )
    results = await search_all(
        query=q,
        filters=filters,
        page=page,
        size=size,
        providers=providers,
    )
    if not results:
        logger.warning("All search providers failed or returned nothing")

    merged = service.round_robin_dedupe(results)
    merged.papers = await service.cache_papers(db, merged.papers)
    response = service.build_search_response(merged)

    # Don't cache total provider failure — the next attempt should retry.
    if results:
        try:
            await cache_set(redis, CACHE_NAMESPACE, "search", cache_id, response)
        except Exception:
            logger.debug("Search cache write failed; continuing without cache")

    return response


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
    return await service.set_paper_state(db, user.id, paper_key, body.state)


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


# ── Paper detail (public) ────────────────────────────────────
# MUST stay the last route in this router: the greedy {paper_key:path}
# with no suffix would otherwise swallow /search, /dismissed, and the
# /{key}/states|tags|dismiss sub-routes above.


@router.get("/{paper_key:path}", response_model=PaperDetailRead)
async def get_paper(paper_key: str, db: DB):
    return await service.get_paper_detail(db, paper_key)
