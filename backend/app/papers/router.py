"""Papers router — lookup, search, states, tags."""

import json
import logging

from fastapi import APIRouter, Query, Request, Response

from app.common.identifiers import PaperKey, parse_lookup_key
from app.common.rate_limit import client_ip, enforce_rate_limit
from app.dependencies import DB, CurrentUser, OptionalUser, Redis
from app.papers import search, service
from app.papers.schemas import (
    PaperDetailRead,
    SearchResultRead,
    SearchSort,
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
    # Semantic Scholar has no author filter: only the served rows are filtered.
    author: str | None = Query(None, max_length=200),
    open_access_only: bool = False,
    sort: SearchSort = "relevance",
    # Continues the date and citation sorts; relevance pages by ``page``.
    cursor: str | None = Query(None, min_length=1, max_length=4096),
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
    from app.providers import registry
    from app.providers.base import SearchFilters
    from app.providers.base import SearchResult as ProviderSearchResult
    from app.providers.cache import cache_get, cache_set

    providers = registry.selected_provider_names(providers)
    # Invalid input is rejected before the cache is read.
    search.validate_years(year_from, year_to)
    author = (author or "").strip() or None
    filters = SearchFilters(
        year_from=year_from,
        year_to=year_to,
        author=author,
        open_access_only=open_access_only,
    )
    position = None
    if cursor is not None:
        position = search.decode_cursor(
            cursor, sort=sort, signature=search.query_signature(q, filters, sort)
        )
    if sort == "relevance":
        search.check_relevance_window(page, size)

    # One cache entry per served page: repeat searches within cache_ttl_search
    # are served from Redis without touching the provider. The version keeps
    # entries of an older response shape from being served.
    cache_id = json.dumps(
        {
            "v": registry.SEARCH_CACHE_VERSION,
            "q": q,
            "providers": sorted(providers),
            "year_from": year_from,
            "year_to": year_to,
            "author": author,
            "open_access_only": open_access_only,
            "sort": sort,
            "cursor": cursor,
            "page": page,
            "size": size,
        },
        sort_keys=True,
    )
    try:
        cached = await cache_get(redis, registry.CACHE_NAMESPACE, "search", cache_id)
    except Exception:  # Redis down → bypass the cache, never fail the search
        cached = None
    if cached is not None:
        return cached

    next_cursor = None
    if sort == "relevance":
        # A provider failure raises (a coded 503/422) and is never cached.
        results = await registry.search_all(
            query=q,
            filters=filters,
            page=page,
            size=size,
            providers=providers,
        )
    else:
        # Only this slice of the cached bulk batch is written to the database.
        chunk = await search.sorted_slice(redis, q, filters, sort, position, size)
        next_cursor = chunk.next_cursor
        results = [
            ProviderSearchResult(
                papers=chunk.papers,
                total_count=len(chunk.papers),
                page=page,
                page_size=size,
                provider=registry.PRIMARY_PROVIDER,
                has_more=next_cursor is not None,
                total_estimate=chunk.total,
            )
        ]

    merged = service.round_robin_dedupe(results)
    merged.papers = await service.cache_papers(db, merged.papers)
    response = service.build_search_response(
        merged,
        sort=sort,
        next_cursor=next_cursor,
        filtered_locally=author is not None,
        source=providers[0],
    )

    # A provider failure raised above and is never cached, so the next attempt
    # retries; an answered search is cached even when nothing matched.
    try:
        await cache_set(redis, registry.CACHE_NAMESPACE, "search", cache_id, response)
    except Exception:
        logger.debug("Search cache write failed; continuing without cache")

    return response


# ── Dismiss (must be before {paper_key:path} routes) ────────


@router.get("/dismissed")
async def get_dismissed(user: CurrentUser, db: DB):
    keys = await service.get_dismissed_keys(db, user.id)
    return keys


# Keys are normalized (bare DOI or DOI link → doi:<lowercase>) on every route
# below; deletes take the raw key and try it before the normalized form so
# rows stored under legacy keys stay removable.


@router.get("/{paper_key:path}/states", response_model=list[StateRead])
async def get_states(paper_key: PaperKey, user: CurrentUser, db: DB):
    return await service.get_paper_states(db, user.id, paper_key)


@router.put("/{paper_key:path}/state", response_model=StateRead)
async def set_state(paper_key: PaperKey, body: StateUpdate, user: CurrentUser, db: DB):
    return await service.set_paper_state(db, user.id, paper_key, body.state)


@router.get("/{paper_key:path}/tags", response_model=list[TagRead])
async def get_tags(paper_key: PaperKey, user: CurrentUser, db: DB):
    return await service.get_tags(db, user.id, paper_key)


@router.post("/{paper_key:path}/tags", response_model=TagRead, status_code=201)
async def add_tag(paper_key: PaperKey, body: TagCreate, user: CurrentUser, db: DB):
    return await service.add_tag(db, user.id, paper_key, body.tag)


@router.delete("/{paper_key:path}/tags/{tag}", status_code=204)
async def remove_tag(paper_key: str, tag: str, user: CurrentUser, db: DB):
    await service.remove_tag(db, user.id, paper_key, tag)


@router.post("/{paper_key:path}/dismiss", status_code=201)
async def dismiss_paper(paper_key: PaperKey, user: CurrentUser, db: DB):
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
async def get_paper(
    paper_key: PaperKey,
    request: Request,
    response: Response,
    user: OptionalUser,
    db: DB,
    redis: Redis,
):
    detail = await service.get_cached_detail(db, paper_key)
    if detail is not None:
        return detail
    # The same test get_paper_detail uses to go live, so bare arXiv IDs and
    # arXiv/Semantic Scholar links are metered as well as prefixed keys.
    parsed = parse_lookup_key(paper_key)
    if parsed is not None and parsed.canonical_key != paper_key:
        detail = await service.get_cached_detail(db, parsed.canonical_key)
        if detail is not None:
            return detail
    if parsed is not None:
        # Only the live provider lookup is metered; cached details are free.
        # A provider that cannot answer right now is a 503 with Retry-After
        # (raised by get_paper_detail), never a 404.
        await enforce_rate_limit(
            redis,
            request,
            response,
            scope="paper-lookup",
            identity=f"user:{user.id}" if user else client_ip(request),
            limit=60 if user else 20,
            window_seconds=60,
            fail_closed=True,
        )
    return await service.get_paper_detail(db, paper_key)
