"""Paper service — search, lookup, states, tags."""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import asdict
from datetime import date
from itertools import zip_longest

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.exceptions import NotFoundError
from app.papers.models import (
    READING_STATES,
    CachedPaperMetadata,
    UserDismissedPaper,
    UserPaperState,
    UserPaperTag,
)
from app.papers.schemas import PaperMetadataRead
from app.providers.base import PaperMetadata, SearchResult as ProviderSearchResult

from fastapi import HTTPException, status


def _paper_sort_key(paper: PaperMetadata | PaperMetadataRead) -> tuple[int, date, str]:
    publication_date = paper.publication_date or date.min
    return (
        1 if paper.publication_date else 0,
        publication_date,
        paper.version or "",
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
    sources = row.provider_sources_json or (
        [row.provider_source] if row.provider_source else []
    )
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


async def cache_papers(db: AsyncSession, papers: list[PaperMetadata]) -> None:
    if not papers:
        return

    existing_rows = await db.execute(
        select(CachedPaperMetadata).where(
            CachedPaperMetadata.canonical_key.in_([paper.canonical_key for paper in papers])
        )
    )
    existing = {row.canonical_key: row for row in existing_rows.scalars().all()}

    for paper in papers:
        row = existing.get(paper.canonical_key)
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
            db.add(
                CachedPaperMetadata(
                    canonical_key=paper.canonical_key,
                    provider_sources_json=incoming_sources,
                    **payload,
                )
            )
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


async def get_cached_paper(db: AsyncSession, canonical_key: str) -> CachedPaperMetadata | None:
    return await db.get(CachedPaperMetadata, canonical_key)


async def get_cached_papers_by_group(
    db: AsyncSession, paper_group_key: str
) -> list[CachedPaperMetadata]:
    result = await db.execute(
        select(CachedPaperMetadata)
        .where(CachedPaperMetadata.paper_group_key == paper_group_key)
        .order_by(CachedPaperMetadata.publication_date.desc(), CachedPaperMetadata.canonical_key)
    )
    return list(result.scalars().all())


async def get_cached_papers_by_keys(
    db: AsyncSession, canonical_keys: set[str]
) -> dict[str, CachedPaperMetadata]:
    if not canonical_keys:
        return {}
    result = await db.execute(
        select(CachedPaperMetadata).where(CachedPaperMetadata.canonical_key.in_(canonical_keys))
    )
    return {row.canonical_key: row for row in result.scalars().all()}


def round_robin_dedupe(results: list[ProviderSearchResult]) -> ProviderSearchResult:
    """Interleave provider results round-robin by rank, deduplicate by
    canonical_key (keeping the earliest-position occurrence), and union
    provider_sources on each kept paper.

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
    seen: dict[str, PaperMetadata] = {}
    ordered: list[PaperMetadata] = []

    for round_papers in zip_longest(*streams):
        for paper in round_papers:
            if paper is None:
                continue
            if paper.canonical_key in seen:
                existing = seen[paper.canonical_key]
                sources = set(_provider_sources_for(existing))
                sources.update(_provider_sources_for(paper))
                existing.provider_sources = sorted(sources)
                continue
            paper.provider_sources = sorted(set(_provider_sources_for(paper)))
            seen[paper.canonical_key] = paper
            ordered.append(paper)

    raw_total = sum(len(r.papers) for r in results)
    provider_names = [r.provider for r in results if r.provider]

    return ProviderSearchResult(
        papers=ordered,
        total_count=raw_total,
        page=results[0].page,
        page_size=results[0].page_size,
        provider="+".join(provider_names),
        providers=provider_names,
    )


def build_search_response(result: ProviderSearchResult) -> dict:
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

    providers_list = result.providers or (
        [result.provider] if result.provider else []
    )

    return {
        "items": items,
        "total_count": len(items),
        "raw_total_count": result.total_count,
        "page": result.page,
        "page_size": result.page_size,
        "providers": providers_list,
    }


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
    result = await db.execute(
        select(UserPaperState).where(
            UserPaperState.user_id == user_id,
            UserPaperState.paper_canonical_key == paper_key,
        )
    )
    return list(result.scalars().all())


async def add_tag(
    db: AsyncSession, user_id: uuid.UUID, paper_key: str, tag: str
) -> UserPaperTag:
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
    cached = await get_cached_paper(db, paper_key)
    if cached is None or not cached.paper_group_key:
        return None, {paper_key}
    rows = await get_cached_papers_by_group(db, cached.paper_group_key)
    group_keys = {row.canonical_key for row in rows}
    group_keys.add(paper_key)
    return cached.paper_group_key, group_keys


async def remove_tag(
    db: AsyncSession, user_id: uuid.UUID, paper_key: str, tag: str
) -> None:
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


async def get_tags(
    db: AsyncSession, user_id: uuid.UUID, paper_key: str
) -> list[UserPaperTag]:
    paper_group_key, group_keys = await _tag_scope(db, paper_key)
    if paper_group_key:
        result = await db.execute(
            select(UserPaperTag)
            .where(
                UserPaperTag.user_id == user_id,
                or_(
                    UserPaperTag.paper_group_key == paper_group_key,
                    UserPaperTag.paper_canonical_key.in_(group_keys),
                ),
            )
            .order_by(UserPaperTag.created_at)
        )
        tags: list[UserPaperTag] = []
        seen: set[str] = set()
        for row in result.scalars().all():
            if row.tag in seen:
                continue
            seen.add(row.tag)
            tags.append(row)
        return tags

    result = await db.execute(
        select(UserPaperTag).where(
            UserPaperTag.user_id == user_id,
            UserPaperTag.paper_canonical_key == paper_key,
        )
    )
    return list(result.scalars().all())


# ── Dismiss ─────────────────────────────────────────────────

async def get_dismissed_keys(
    db: AsyncSession, user_id: uuid.UUID
) -> list[str]:
    result = await db.execute(
        select(UserDismissedPaper.paper_canonical_key).where(
            UserDismissedPaper.user_id == user_id
        )
    )
    return list(result.scalars().all())


async def dismiss_paper(
    db: AsyncSession, user_id: uuid.UUID, paper_key: str
) -> UserDismissedPaper:
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


async def undismiss_paper(
    db: AsyncSession, user_id: uuid.UUID, paper_key: str
) -> None:
    result = await db.execute(
        select(UserDismissedPaper).where(
            UserDismissedPaper.user_id == user_id,
            UserDismissedPaper.paper_canonical_key == paper_key,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        return  # idempotent — already undismissed
    await db.delete(row)
