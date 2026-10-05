"""Paper service — search, lookup, states, tags."""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import date
from itertools import zip_longest
from typing import TYPE_CHECKING, Literal

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.exceptions import ApiError, NotFoundError
from app.common.identifiers import ParsedIdentifier, normalize_paper_key, parse_lookup_key
from app.papers.models import (
    READING_STATES,
    CachedPaperMetadata,
    UserDismissedPaper,
    UserPaperState,
    UserPaperTag,
)
from app.papers.schemas import PaperMetadataRead
from app.providers.base import Author, PaperMetadata
from app.providers.base import SearchResult as ProviderSearchResult
from app.providers.identity import deduplicate, normalize_arxiv, normalize_doi

if TYPE_CHECKING:
    from app.providers.registry import DoiLookup


def _version_number(version: str | None) -> int:
    """``"v10"`` -> 10, so v10 sorts after v9; anything unparseable is 0."""
    try:
        return int((version or "").strip().lower().lstrip("v"))
    except ValueError:
        return 0


def _paper_sort_key(paper: PaperMetadata | PaperMetadataRead) -> tuple[int, date, int]:
    publication_date = paper.publication_date or date.min
    return (
        1 if paper.publication_date else 0,
        publication_date,
        _version_number(paper.version),
    )


def serialize_paper_metadata(paper: PaperMetadata) -> dict:
    return PaperMetadataRead.model_validate(asdict(paper)).model_dump(mode="json")


def _provider_sources_for(paper: PaperMetadata) -> list[str]:
    """Return the canonical provider_sources list for a paper, falling back
    to a single-element list of provider_source if not yet aggregated."""
    if paper.provider_sources:
        return list(paper.provider_sources)
    return [paper.provider_source] if paper.provider_source else []


def cached_paper_to_read(row: CachedPaperMetadata) -> PaperMetadataRead:
    sources = row.provider_sources_json or ([row.provider_source] if row.provider_source else [])
    return PaperMetadataRead.model_validate(
        {
            "canonical_key": row.canonical_key,
            "paper_group_key": row.paper_group_key,
            "title": row.title,
            "authors": row.authors_json,
            "abstract": row.abstract,
            "publication_date": row.publication_date,
            "doi": row.doi,
            "arxiv_id": row.arxiv_id,
            "pmid": row.pmid,
            "pmcid": row.pmcid,
            "openalex_id": row.openalex_id,
            "semantic_scholar_id": row.semantic_scholar_id,
            "venue": row.venue,
            "volume": row.volume,
            "issue": row.issue,
            "pages": row.pages,
            "paper_type": row.paper_type,
            "topics": row.topics_json,
            "keywords": row.keywords_json,
            "open_access": row.open_access,
            "pdf_url": row.pdf_url,
            "abstract_url": row.abstract_url,
            "cited_by_count": row.cited_by_count,
            "reference_count": row.reference_count,
            "version": row.version,
            "provider_source": row.provider_source,
            "provider_sources": sources,
        }
    )


async def cache_papers(db: AsyncSession, papers: list[PaperMetadata]) -> list[PaperMetadata]:
    """Upsert by strong identity without renaming keys already used by saved data.

    A later DOI may enrich an S2-only snapshot. Keep its durable key, and resolve
    both aliases in get_cached_paper; never orphan library pins, notes or edges.
    """
    papers = deduplicate(papers)
    if not papers:
        return []
    clauses = [CachedPaperMetadata.canonical_key.in_([p.canonical_key for p in papers])]
    for field in ("semantic_scholar_id", "doi", "arxiv_id", "pmid", "pmcid"):
        values = [getattr(p, field) for p in papers if getattr(p, field)]
        if values:
            clauses.append(getattr(CachedPaperMetadata, field).in_(values))
    rows = list((await db.execute(select(CachedPaperMetadata).where(or_(*clauses)))).scalars())
    stored = []
    for paper in papers:
        row = None
        for candidate in sorted(rows, key=lambda r: r.canonical_key):
            data = cached_paper_to_read(candidate).model_dump()
            data["authors"] = [Author(**author) for author in data["authors"]]
            combined = deduplicate([PaperMetadata(**data), paper])
            if len(combined) == 1:
                row = candidate
                paper = combined[0]
                paper.canonical_key = row.canonical_key
                # Group keys anchor notes/tags. Preserve the existing anchor.
                paper.paper_group_key = row.paper_group_key
                break
        stored.append(paper)
        incoming_sources = _provider_sources_for(paper)
        payload = {
            "paper_group_key": paper.paper_group_key,
            "title": paper.title,
            "authors_json": [asdict(author) for author in paper.authors],
            "abstract": paper.abstract,
            "publication_date": paper.publication_date,
            "doi": paper.doi,
            "arxiv_id": paper.arxiv_id,
            "pmid": paper.pmid,
            "pmcid": paper.pmcid,
            "openalex_id": paper.openalex_id,
            "semantic_scholar_id": paper.semantic_scholar_id,
            "venue": paper.venue,
            "volume": paper.volume,
            "issue": paper.issue,
            "pages": paper.pages,
            "paper_type": paper.paper_type,
            "topics_json": paper.topics,
            "keywords_json": paper.keywords,
            "open_access": paper.open_access,
            "pdf_url": paper.pdf_url,
            "abstract_url": paper.abstract_url,
            "cited_by_count": paper.cited_by_count,
            "reference_count": paper.reference_count,
            "version": paper.version,
            "provider_source": paper.provider_source,
        }
        if row is None:
            row = CachedPaperMetadata(
                canonical_key=paper.canonical_key,
                provider_sources_json=incoming_sources,
                **payload,
            )
            db.add(row)
            rows.append(row)
            continue
        for field_name, value in payload.items():
            setattr(row, field_name, value)
        existing_sources = set(
            row.provider_sources_json or ([row.provider_source] if row.provider_source else [])
        )
        existing_sources.update(incoming_sources)
        row.provider_sources_json = sorted(existing_sources)
        db.add(row)

    await db.flush()
    return stored


# Alias prefix -> cached column, for keys that are not the row's own key.
_ALIAS_FIELDS = {
    "s2": "semantic_scholar_id",
    "doi": "doi",
    "arxiv": "arxiv_id",
    "pmid": "pmid",
    "pmcid": "pmcid",
}


def _alias_value(prefix: str, value: str) -> str:
    # The same normalizers as ``identity.aliases``.
    normalize = {
        "doi": normalize_doi,
        "arxiv": normalize_arxiv,
        "s2": str.lower,
        "pmcid": str.upper,
    }.get(prefix)
    return normalize(value.strip()) if normalize else value.strip()


async def get_cached_paper(db: AsyncSession, canonical_key: str) -> CachedPaperMetadata | None:
    row = await db.get(CachedPaperMetadata, canonical_key)
    if row is not None:
        return row
    prefix, _, value = canonical_key.partition(":")
    if prefix not in _ALIAS_FIELDS:
        return None
    result = await db.execute(
        select(CachedPaperMetadata)
        .where(getattr(CachedPaperMetadata, _ALIAS_FIELDS[prefix]) == _alias_value(prefix, value))
        .order_by(CachedPaperMetadata.canonical_key)
        .limit(1)
    )
    return result.scalar_one_or_none()


async def get_cached_papers_by_group(
    db: AsyncSession, paper_group_key: str
) -> list[CachedPaperMetadata]:
    result = await db.execute(
        select(CachedPaperMetadata)
        .where(CachedPaperMetadata.paper_group_key == paper_group_key)
        .order_by(CachedPaperMetadata.publication_date.desc(), CachedPaperMetadata.canonical_key)
    )
    return list(result.scalars().all())


async def get_cached_papers_by_groups(
    db: AsyncSession, paper_group_keys: set[str]
) -> dict[str, list[CachedPaperMetadata]]:
    """Batched ``get_cached_papers_by_group``: versions per group, same order."""
    if not paper_group_keys:
        return {}
    result = await db.execute(
        select(CachedPaperMetadata)
        .where(CachedPaperMetadata.paper_group_key.in_(paper_group_keys))
        .order_by(CachedPaperMetadata.publication_date.desc(), CachedPaperMetadata.canonical_key)
    )
    grouped: dict[str, list[CachedPaperMetadata]] = defaultdict(list)
    for row in result.scalars().all():
        grouped[row.paper_group_key].append(row)
    return dict(grouped)


@dataclass
class ResolvedPaper:
    status: Literal["found", "not_found", "unavailable"]
    row: CachedPaperMetadata | None = None
    # Provider's Retry-After (seconds) for an ``unavailable`` lookup, if known.
    retry_after: int | None = None
    # Provider's error code for an ``unavailable`` lookup, if it gave one.
    code: str | None = None


async def lookup_identifier(parsed: ParsedIdentifier, *, confirm_missing: bool = True) -> DoiLookup:
    """Ask the provider about ``parsed``; no database access, so callers can
    run it with no transaction open. DOIs go through ``registry.resolve_doi``
    (doi.org confirms a miss; a registered DOI the provider cannot describe is
    ``unavailable`` and may be saved as pending); ``s2:``, ``arxiv:``,
    ``pmid:`` and ``pmcid:`` through ``registry.resolve_id``, where a miss is
    definitive. A ``hash:`` key is never looked up."""
    from app.providers import registry

    if parsed.doi is not None:
        return await registry.resolve_doi(parsed.doi, confirm_missing=confirm_missing)
    if parsed.lookup_id is None:
        return registry.DoiLookup("not_found")
    return await registry.resolve_id(parsed.lookup_id)


async def store_paper(db: AsyncSession, paper: PaperMetadata) -> CachedPaperMetadata | None:
    """Upsert a provider record and return the row it is stored as. The upsert
    merges it into a row already holding one of its aliases and keeps that
    row's key and group, so writes must use the returned row's keys (a DOI
    found for a paper cached as ``s2:Y`` stays ``s2:Y``)."""
    stored = (await cache_papers(db, [paper]))[0]
    return await get_cached_paper(db, stored.canonical_key)


_OPERATOR_CODES = {
    "provider_not_configured": "Semantic Scholar is not configured on this server.",
    "provider_key_rejected": "Semantic Scholar rejected this server's API key.",
}


def provider_unavailable(retry_after: int | None, code: str | None = None) -> ApiError:
    """503 for an identifier the provider could not resolve right now
    (nothing was saved). Keeps the provider's code: configuration problems
    are reported as such and carry no ``Retry-After``; anything else is
    ``provider_unavailable`` (or ``provider_rate_limited``) with a retry hint."""
    from app.providers.semantic_scholar import DEFAULT_RETRY_AFTER, ProviderError

    if code in _OPERATOR_CODES:
        return ProviderError(code, _OPERATOR_CODES[code])
    if code == "provider_rate_limited":
        return ProviderError(
            code,
            "Semantic Scholar is rate limiting requests; please retry.",
            retry_after=retry_after or DEFAULT_RETRY_AFTER,
        )
    return ProviderError(
        "provider_unavailable",
        "Semantic Scholar is unavailable; please retry.",
        retry_after=retry_after or DEFAULT_RETRY_AFTER,
    )


async def resolve_identifier(db: AsyncSession, parsed: ParsedIdentifier) -> ResolvedPaper:
    """Cached snapshot first (alias-aware), then the provider for DOIs and the
    other strong identifiers, upserting the snapshot. A DOI miss is not
    confirmed with doi.org here: it is ``not_found``. Only for callers that
    hold no per-user lock: write paths split the provider call out of their
    transaction instead."""
    row = await get_cached_paper(db, parsed.canonical_key)
    if row is not None:
        return ResolvedPaper("found", row)
    if parsed.lookup_id is None:
        return ResolvedPaper("not_found")
    lookup = await lookup_identifier(parsed, confirm_missing=False)
    if lookup.paper is None:
        return ResolvedPaper(lookup.status, retry_after=lookup.retry_after, code=lookup.code)
    return ResolvedPaper("found", await store_paper(db, lookup.paper))


async def _detail_from_row(db: AsyncSession, row: CachedPaperMetadata) -> dict:
    detail = cached_paper_to_read(row).model_dump(mode="json")
    siblings = await get_cached_papers_by_group(db, row.paper_group_key)
    detail["versions"] = [
        cached_paper_to_read(sibling).model_dump(mode="json") for sibling in siblings
    ]
    return detail


async def get_cached_detail(db: AsyncSession, canonical_key: str) -> dict | None:
    row = await get_cached_paper(db, normalize_paper_key(canonical_key))
    return await _detail_from_row(db, row) if row is not None else None


async def get_paper_detail(
    db: AsyncSession, canonical_key: str, *, allow_lookup: bool = True
) -> dict:
    """Hydrate a single paper from the durable metadata snapshot, falling
    back to a live lookup of a DOI or another strong identifier (which
    upserts the snapshot) on a cache miss.

    The key is normalized first, so a bare DOI or a DOI link resolves too.
    A definitive miss, and a ``hash:`` key with no cached row, is a 404; a
    provider that cannot answer right now is a 503 with ``Retry-After``.
    """
    key = normalize_paper_key(canonical_key)
    row = await get_cached_paper(db, key)

    if row is None and allow_lookup and (parsed := parse_lookup_key(key)) is not None:
        resolved = await resolve_identifier(db, parsed)
        if resolved.status == "unavailable":
            raise provider_unavailable(resolved.retry_after, resolved.code)
        row = resolved.row

    if row is None:
        raise NotFoundError(f"Paper not found: {key}")

    return await _detail_from_row(db, row)


async def get_cached_papers_by_keys(
    db: AsyncSession, canonical_keys: set[str]
) -> dict[str, CachedPaperMetadata]:
    if not canonical_keys:
        return {}
    result = await db.execute(
        select(CachedPaperMetadata).where(CachedPaperMetadata.canonical_key.in_(canonical_keys))
    )
    return {row.canonical_key: row for row in result.scalars().all()}


async def get_cached_papers_by_aliases(
    db: AsyncSession, keys: set[str]
) -> dict[str, CachedPaperMetadata]:
    """Batched ``get_cached_paper``: per key, the row stored under it, else the
    row with the lowest canonical key holding it as an alias (an ``s2:`` row
    enriched with a DOI answers for that ``doi:`` key)."""
    found = await get_cached_papers_by_keys(db, keys)
    result = {key: found[key] for key in keys if key in found}
    wanted: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for key in keys - result.keys():
        prefix, _, value = key.partition(":")
        if prefix in _ALIAS_FIELDS:
            wanted[_ALIAS_FIELDS[prefix]][_alias_value(prefix, value)].append(key)
    for field, by_value in wanted.items():
        column = getattr(CachedPaperMetadata, field)
        rows = await db.execute(
            select(CachedPaperMetadata)
            .where(column.in_(by_value))
            .order_by(CachedPaperMetadata.canonical_key)
        )
        for row in rows.scalars().all():
            for key in by_value.get(getattr(row, field), ()):
                result.setdefault(key, row)
    return result


def round_robin_dedupe(results: list[ProviderSearchResult]) -> ProviderSearchResult:
    """Interleave provider results by rank, merge strong identity aliases and
    complementary metadata, retaining the first result position.

    Returns a synthetic SearchResult whose `.papers` preserves the merged
    order, `.providers` is the list of provider names that contributed,
    `.provider` is the legacy plus-joined string for backwards compatibility,
    and `.total_count` is the total number of paper rows received before
    dedup (so downstream `raw_total_count` stays meaningful).
    """
    if not results:
        return ProviderSearchResult(
            papers=[],
            total_count=0,
            page=1,
            page_size=0,
            provider="",
            providers=[],
        )

    streams = [r.papers for r in results]
    ordered = deduplicate(
        [
            paper
            for round_papers in zip_longest(*streams)
            for paper in round_papers
            if paper is not None
        ]
    )

    raw_total = sum(len(r.papers) for r in results)
    provider_names = [r.provider for r in results if r.provider]
    # The providers' own match counts, taken before deduplication shrinks the page.
    estimates = [r.total_estimate for r in results if r.total_estimate is not None]

    return ProviderSearchResult(
        papers=ordered,
        total_count=raw_total,
        page=results[0].page,
        page_size=results[0].page_size,
        provider="+".join(provider_names),
        providers=provider_names,
        has_more=any(result.has_more for result in results),
        total_estimate=sum(estimates) if estimates else None,
        window_capped=any(result.window_capped for result in results),
    )


def build_search_response(
    result: ProviderSearchResult,
    *,
    sort: Literal["relevance", "date", "citations"] = "relevance",
    next_cursor: str | None = None,
    filtered_locally: bool = False,
    source: str | None = None,
) -> dict:
    """Group the served rows by ``paper_group_key`` in first-appearance
    order (the provider's sort order) and flag possible other versions
    among them (``papers.similarity``; never merged)."""
    from app.papers.similarity import find_possible_versions

    grouped: dict[str, list[tuple[int, PaperMetadata]]] = defaultdict(list)
    for index, paper in enumerate(result.papers):
        grouped[paper.paper_group_key].append((index, paper))

    ordered_group_keys: list[str] = []
    seen_group_keys: set[str] = set()
    for paper in result.papers:
        if paper.paper_group_key not in seen_group_keys:
            ordered_group_keys.append(paper.paper_group_key)
            seen_group_keys.add(paper.paper_group_key)

    items: list[dict] = []
    for group_key in ordered_group_keys:
        papers_with_index = grouped[group_key]
        versions = [
            serialize_paper_metadata(paper)
            for _, paper in sorted(
                papers_with_index,
                key=lambda item: (_paper_sort_key(item[1]), -item[0]),
                reverse=True,
            )
        ]
        selected_version = versions[0]
        if len(versions) == 1:
            items.append({"kind": "paper", "paper": selected_version})
            continue

        first_paper = papers_with_index[0][1]
        group_sources: set[str] = set()
        for _, paper in papers_with_index:
            group_sources.update(_provider_sources_for(paper))
        items.append(
            {
                "kind": "paper_group",
                "paper_group_key": group_key,
                "title": first_paper.title,
                "authors": [asdict(author) for author in first_paper.authors],
                "version_count": len(versions),
                "selected_version": selected_version,
                "versions": versions,
                "provider_sources": sorted(group_sources),
            }
        )

    # One item per group, in ``ordered_group_keys`` order.
    summaries = {
        group_key: {
            "paper_group_key": group_key,
            "title": grouped[group_key][0][1].title,
            "provider_sources": sorted(
                {name for _, paper in grouped[group_key] for name in _provider_sources_for(paper)}
            ),
        }
        for group_key in ordered_group_keys
    }
    related = find_possible_versions(result.papers)
    for group_key, item in zip(ordered_group_keys, items, strict=True):
        item["possible_versions"] = [summaries[other] for other in related.get(group_key, [])]

    providers_list = result.providers or ([result.provider] if result.provider else [])

    payload = {
        "items": items,
        "total_count": len(items),
        "raw_total_count": result.total_count,
        "has_more": result.has_more,
        "page": result.page,
        "page_size": result.page_size,
        "providers": providers_list,
        "sort": sort,
        "next_cursor": next_cursor,
        "total_estimate": result.total_estimate,
        "window_capped": result.window_capped,
        "filtered_locally": filtered_locally,
    }
    if source:
        payload["source"] = source
    return payload


async def set_paper_state(
    db: AsyncSession,
    user_id: uuid.UUID,
    paper_key: str,
    state: str,
) -> UserPaperState:
    if state not in READING_STATES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid state. Must be one of: {', '.join(READING_STATES)}",
        )

    existing = await db.execute(
        select(UserPaperState).where(
            UserPaperState.user_id == user_id,
            UserPaperState.paper_canonical_key == paper_key,
        )
    )
    ups = existing.scalar_one_or_none()
    if ups:
        ups.state = state
    else:
        ups = UserPaperState(
            user_id=user_id,
            paper_canonical_key=paper_key,
            state=state,
        )
    db.add(ups)
    await db.flush()
    return ups


async def get_paper_states(
    db: AsyncSession, user_id: uuid.UUID, paper_key: str
) -> list[UserPaperState]:
    return (await get_paper_states_batch(db, user_id, [paper_key]))[paper_key]


async def get_paper_states_batch(
    db: AsyncSession, user_id: uuid.UUID, paper_keys: list[str]
) -> dict[str, list[UserPaperState]]:
    """Batched ``get_paper_states``: the user's states per exact key."""
    states: dict[str, list[UserPaperState]] = {key: [] for key in paper_keys}
    if not states:
        return states
    result = await db.execute(
        select(UserPaperState).where(
            UserPaperState.user_id == user_id,
            UserPaperState.paper_canonical_key.in_(list(states)),
        )
    )
    for row in result.scalars().all():
        states[row.paper_canonical_key].append(row)
    return states


async def add_tag(db: AsyncSession, user_id: uuid.UUID, paper_key: str, tag: str) -> UserPaperTag:
    paper_group_key, group_keys = await _tag_scope(db, paper_key)
    if paper_group_key:
        existing = await db.execute(
            select(UserPaperTag).where(
                UserPaperTag.user_id == user_id,
                UserPaperTag.tag == tag,
                or_(
                    UserPaperTag.paper_group_key == paper_group_key,
                    UserPaperTag.paper_canonical_key.in_(group_keys),
                ),
            )
        )
    else:
        existing = await db.execute(
            select(UserPaperTag).where(
                UserPaperTag.user_id == user_id,
                UserPaperTag.paper_canonical_key == paper_key,
                UserPaperTag.tag == tag,
            )
        )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Tag already exists")

    upt = UserPaperTag(
        user_id=user_id,
        paper_canonical_key=paper_key,
        tag=tag,
        paper_group_key=paper_group_key,
    )
    db.add(upt)
    await db.flush()
    return upt


async def _tag_scope(db: AsyncSession, paper_key: str) -> tuple[str | None, set[str]]:
    return (await _tag_scopes(db, [paper_key]))[paper_key]


async def _tag_scopes(
    db: AsyncSession, paper_keys: list[str]
) -> dict[str, tuple[str | None, set[str]]]:
    """Per key, the paper group its tags are shared across and the version
    keys of that group (legacy tags stored without a group key), or
    ``(None, {key})`` for a key with no cached paper."""
    cached = await get_cached_papers_by_aliases(db, set(paper_keys))
    siblings = await get_cached_papers_by_groups(
        db, {row.paper_group_key for row in cached.values() if row.paper_group_key}
    )
    scopes: dict[str, tuple[str | None, set[str]]] = {}
    for key in paper_keys:
        row = cached.get(key)
        if row is None or not row.paper_group_key:
            scopes[key] = (None, {key})
            continue
        group_keys = {sibling.canonical_key for sibling in siblings.get(row.paper_group_key, [])}
        group_keys.add(key)
        scopes[key] = (row.paper_group_key, group_keys)
    return scopes


async def remove_tag(db: AsyncSession, user_id: uuid.UUID, paper_key: str, tag: str) -> None:
    """Exact key first, then the normalized one, so tags stored under a
    legacy raw key stay removable."""
    try:
        await _remove_tag(db, user_id, paper_key, tag)
    except NotFoundError:
        normalized = normalize_paper_key(paper_key)
        if normalized == paper_key:
            raise
        await _remove_tag(db, user_id, normalized, tag)


async def _remove_tag(db: AsyncSession, user_id: uuid.UUID, paper_key: str, tag: str) -> None:
    paper_group_key, group_keys = await _tag_scope(db, paper_key)
    if paper_group_key:
        result = await db.execute(
            select(UserPaperTag).where(
                UserPaperTag.user_id == user_id,
                UserPaperTag.tag == tag,
                or_(
                    UserPaperTag.paper_group_key == paper_group_key,
                    UserPaperTag.paper_canonical_key.in_(group_keys),
                ),
            )
        )
        rows = list(result.scalars().all())
        if not rows:
            raise NotFoundError("Tag not found")
        for row in rows:
            await db.delete(row)
        return

    result = await db.execute(
        select(UserPaperTag).where(
            UserPaperTag.user_id == user_id,
            UserPaperTag.paper_canonical_key == paper_key,
            UserPaperTag.tag == tag,
        )
    )
    upt = result.scalar_one_or_none()
    if upt is None:
        raise NotFoundError("Tag not found")
    await db.delete(upt)


async def get_tags(db: AsyncSession, user_id: uuid.UUID, paper_key: str) -> list[UserPaperTag]:
    return (await get_tags_batch(db, user_id, [paper_key]))[paper_key]


async def get_tags_batch(
    db: AsyncSession, user_id: uuid.UUID, paper_keys: list[str]
) -> dict[str, list[UserPaperTag]]:
    """Batched ``get_tags``: per key, the user's tags on any version of its
    paper group (one row per tag, oldest first), or on the exact key when the
    paper is not cached."""
    tags: dict[str, list[UserPaperTag]] = {key: [] for key in paper_keys}
    if not tags:
        return tags
    scopes = await _tag_scopes(db, list(tags))
    group_keys = {group for group, _ in scopes.values() if group}
    version_keys = set().union(*(keys for _, keys in scopes.values()))
    conditions = [UserPaperTag.paper_canonical_key.in_(version_keys)]
    if group_keys:
        conditions.append(UserPaperTag.paper_group_key.in_(group_keys))
    result = await db.execute(
        select(UserPaperTag)
        .where(UserPaperTag.user_id == user_id, or_(*conditions))
        # Tags added in one transaction share created_at: break ties stably.
        .order_by(UserPaperTag.created_at, UserPaperTag.tag, UserPaperTag.paper_canonical_key)
    )
    rows = list(result.scalars().all())
    by_group: dict[str, list[int]] = defaultdict(list)
    by_key: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        if row.paper_group_key:
            by_group[row.paper_group_key].append(index)
        by_key[row.paper_canonical_key].append(index)
    for key, (group, keys) in scopes.items():
        indexes = set(by_key[key])
        if group:
            indexes.update(by_group[group])
            for version_key in keys:
                indexes.update(by_key[version_key])
        seen: set[str] = set()
        for index in sorted(indexes):
            if rows[index].tag not in seen:
                seen.add(rows[index].tag)
                tags[key].append(rows[index])
    return tags


# ── Dismiss ─────────────────────────────────────────────────


async def get_dismissed_keys(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
    result = await db.execute(
        select(UserDismissedPaper.paper_canonical_key).where(UserDismissedPaper.user_id == user_id)
    )
    return list(result.scalars().all())


async def dismiss_paper(db: AsyncSession, user_id: uuid.UUID, paper_key: str) -> UserDismissedPaper:
    existing = await db.execute(
        select(UserDismissedPaper).where(
            UserDismissedPaper.user_id == user_id,
            UserDismissedPaper.paper_canonical_key == paper_key,
        )
    )
    row = existing.scalar_one_or_none()
    if row is not None:
        return row  # idempotent
    dp = UserDismissedPaper(user_id=user_id, paper_canonical_key=paper_key)
    db.add(dp)
    await db.flush()
    return dp


async def undismiss_paper(db: AsyncSession, user_id: uuid.UUID, paper_key: str) -> None:
    # Exact key first, then the normalized one (legacy raw keys).
    for key in dict.fromkeys((paper_key, normalize_paper_key(paper_key))):
        result = await db.execute(
            select(UserDismissedPaper).where(
                UserDismissedPaper.user_id == user_id,
                UserDismissedPaper.paper_canonical_key == key,
            )
        )
        row = result.scalar_one_or_none()
        if row is not None:
            await db.delete(row)
            return
    # idempotent — already undismissed
