"""OpenAlex provider implementation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import ClassVar, Literal
from urllib.parse import quote

import httpx

from app.common.identifiers import strip_doi_prefixes
from app.config import settings
from app.providers.base import (
    Author,
    AuthorMetadata,
    BaseProvider,
    PaperMetadata,
    PaperReference,
    ProviderCapability,
    SearchFilters,
    SearchResult,
    build_canonical_key,
    build_paper_group_key,
)
from app.providers.rate_limiter import ProviderRateLimiter

_BASE = "https://api.openalex.org"


def _reconstruct_abstract(inverted_index: dict | None) -> str | None:
    """Reconstruct abstract from OpenAlex inverted index format."""
    if not inverted_index:
        return None
    word_positions: list[tuple[int, str]] = []
    for word, positions in inverted_index.items():
        for pos in positions:
            word_positions.append((pos, word))
    word_positions.sort(key=lambda x: x[0])
    return " ".join(w for _, w in word_positions)


def _parse_date(raw: str | None) -> date | None:
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def _params() -> dict:
    p: dict[str, str] = {}
    if settings.openalex_email:
        p["mailto"] = settings.openalex_email
    if settings.openalex_api_key:
        p["api_key"] = settings.openalex_api_key
    return p


def _work_keys(raw: dict) -> tuple[str, str]:
    """``(canonical_key, paper_group_key)`` of a raw work. Shared by
    ``_map_work`` and the compact related-list entries, so a paper gets the
    same keys whichever way it was fetched."""
    doi_raw = raw.get("doi") or ""
    doi = doi_raw.removeprefix("https://doi.org/") if doi_raw else None
    names = [a.get("author", {}).get("display_name", "") for a in raw.get("authorships", [])]
    canonical_key = build_canonical_key(
        doi=doi,
        title=raw.get("title"),
        authors=names,
        year=raw.get("publication_year"),
    )
    return canonical_key, build_paper_group_key(raw.get("title"), names)


def _short_id(work_id: str | None) -> str:
    return (work_id or "").rsplit("/", 1)[-1]


def _related_entry(raw: dict) -> list:
    """Compact snapshot entry: ``[short_id, canonical_key, group_key, title,
    cited_by_count, publication_date]``."""
    canonical_key, group_key = _work_keys(raw)
    return [
        _short_id(raw.get("id")),
        canonical_key,
        group_key,
        (raw.get("title") or "")[:300],
        raw.get("cited_by_count"),
        raw.get("publication_date"),
    ]


# Root fields that cover every key input of ``_work_keys`` plus the ordering
# and display fields of an entry; abstracts and locations stay out of lists.
_RELATED_SELECT = "id,doi,title,authorships,publication_year,publication_date,cited_by_count"


@dataclass
class RelatedPage:
    """One cursor page of a related-works list. ``count`` is OpenAlex's
    ``meta.count``; ``next_cursor`` is ``None`` at the end of the list."""

    entries: list[list]
    count: int
    next_cursor: str | None


def _map_work(raw: dict) -> PaperMetadata:
    doi_raw = raw.get("doi") or ""
    doi = doi_raw.removeprefix("https://doi.org/") if doi_raw else None

    authors: list[Author] = []
    for a in raw.get("authorships", []):
        author_data = a.get("author", {})
        authors.append(
            Author(
                name=author_data.get("display_name", ""),
                openalex_id=author_data.get("id"),
                orcid=author_data.get("orcid"),
                affiliations=[
                    inst.get("display_name", "")
                    for inst in a.get("institutions", [])
                    if inst.get("display_name")
                ],
            )
        )

    biblio = raw.get("biblio", {}) or {}
    pages = None
    fp, lp = biblio.get("first_page"), biblio.get("last_page")
    if fp:
        pages = f"{fp}–{lp}" if lp and lp != fp else fp

    primary_loc = raw.get("primary_location") or {}
    source = primary_loc.get("source") or {}

    oa = raw.get("open_access") or {}

    key, group_key = _work_keys(raw)

    return PaperMetadata(
        canonical_key=key,
        paper_group_key=group_key,
        title=raw.get("title", ""),
        authors=authors,
        abstract=_reconstruct_abstract(raw.get("abstract_inverted_index")),
        publication_date=_parse_date(raw.get("publication_date")),
        doi=doi,
        openalex_id=raw.get("id"),
        venue=source.get("display_name"),
        volume=biblio.get("volume"),
        issue=biblio.get("issue"),
        pages=pages,
        paper_type=raw.get("type"),
        topics=[t.get("display_name", "") for t in raw.get("topics", []) if t.get("display_name")],
        keywords=[k.get("keyword", "") for k in raw.get("keywords", []) if k.get("keyword")],
        open_access=oa.get("is_oa"),
        pdf_url=oa.get("oa_url"),
        cited_by_count=raw.get("cited_by_count"),
        reference_count=raw.get("referenced_works_count"),
        provider_source="openalex",
        raw_response=raw,
    )


class OpenAlexProvider(BaseProvider):
    name = "openalex"
    capabilities: ClassVar[set[ProviderCapability]] = {
        ProviderCapability.LOOKUP_DOI,
        ProviderCapability.LOOKUP_ID,
        ProviderCapability.SEARCH,
        ProviderCapability.REFERENCES,
        ProviderCapability.CITATIONS,
        ProviderCapability.AUTHOR_PROFILE,
        ProviderCapability.FULL_TEXT_LINK,
    }

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(base_url=_BASE, timeout=30)
        self._limiter = ProviderRateLimiter(calls_per_second=10)

    async def lookup_by_doi(self, doi: str) -> PaperMetadata | None:
        await self._limiter.acquire()
        # Quoted so DOIs containing "#", "?" or "<" stay inside the URL path.
        clean = quote(strip_doi_prefixes(doi), safe="/")
        resp = await self._client.get(f"/works/doi:{clean}", params=_params())
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return _map_work(resp.json())

    async def lookup_by_id(self, provider_id: str) -> PaperMetadata | None:
        await self._limiter.acquire()
        resp = await self._client.get(f"/works/{provider_id}", params=_params())
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return _map_work(resp.json())

    async def search(
        self, query: str, filters: SearchFilters, page: int = 1, size: int = 20
    ) -> SearchResult:
        await self._limiter.acquire()
        params = _params()
        params["search"] = query
        params["page"] = str(page)
        params["per_page"] = str(min(size, 200))

        filter_parts: list[str] = []
        if filters.year_from:
            filter_parts.append(f"publication_year:>{filters.year_from - 1}")
        if filters.year_to:
            filter_parts.append(f"publication_year:<{filters.year_to + 1}")
        if filters.author:
            filter_parts.append(f"authorships.author.display_name.search:{filters.author}")
        if filters.venue:
            filter_parts.append(f"primary_location.source.display_name.search:{filters.venue}")
        if filters.open_access_only:
            filter_parts.append("open_access.is_oa:true")
        if filters.paper_type:
            filter_parts.append(f"type:{filters.paper_type}")
        if filter_parts:
            params["filter"] = ",".join(filter_parts)

        resp = await self._client.get("/works", params=params)
        resp.raise_for_status()
        data = resp.json()

        papers = [_map_work(w) for w in data.get("results", [])]
        meta = data.get("meta", {})
        return SearchResult(
            papers=papers,
            total_count=meta.get("count", len(papers)),
            page=page,
            page_size=size,
            provider="openalex",
        )

    async def get_references(self, paper_id: str) -> list[PaperReference]:
        await self._limiter.acquire()
        resp = await self._client.get(f"/works/{paper_id}", params=_params())
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        data = resp.json()
        refs: list[PaperReference] = []
        for ref_id in data.get("referenced_works", []):
            refs.append(
                PaperReference(
                    canonical_key=ref_id,
                    relation_type="references",
                )
            )
        return refs

    async def get_citations(self, paper_id: str) -> list[PaperReference]:
        await self._limiter.acquire()
        params = _params()
        params["filter"] = f"cites:{paper_id}"
        params["per_page"] = "50"
        resp = await self._client.get("/works", params=params)
        resp.raise_for_status()
        data = resp.json()
        return [
            PaperReference(
                canonical_key=w.get("id", ""),
                title=w.get("title"),
                doi=(w.get("doi") or "").removeprefix("https://doi.org/") or None,
                relation_type="cited_by",
            )
            for w in data.get("results", [])
        ]

    async def _related_works(
        self, paper_id: str, *, filter_key: str, sort: str, per_page: int
    ) -> list[PaperMetadata]:
        """Fully-mapped works related to ``paper_id`` via an OpenAlex filter
        (``cites`` → citing papers, ``cited_by`` → references). Each result
        carries canonical/group keys and ``cited_by_count`` so it can become a
        graph node directly. ``sort`` is an OpenAlex sort expression
        (``cited_by_count:desc`` for most influential, ``publication_date:desc``
        for most recent)."""
        await self._limiter.acquire()
        work_id = paper_id.rsplit("/", 1)[-1]
        params = _params()
        params["filter"] = f"{filter_key}:{work_id}"
        params["sort"] = sort
        params["per_page"] = str(max(1, min(per_page, 200)))
        resp = await self._client.get("/works", params=params)
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        data = resp.json()
        return [_map_work(w) for w in data.get("results", [])]

    async def list_citing_papers(
        self, paper_id: str, *, sort: str = "cited_by_count:desc", per_page: int = 25
    ) -> list[PaperMetadata]:
        """Papers that cite ``paper_id`` (``filter=cites:{id}``)."""
        return await self._related_works(paper_id, filter_key="cites", sort=sort, per_page=per_page)

    async def list_referenced_papers(
        self, paper_id: str, *, sort: str = "cited_by_count:desc", per_page: int = 25
    ) -> list[PaperMetadata]:
        """Papers that ``paper_id`` cites — its references (``filter=cited_by:{id}``)."""
        return await self._related_works(
            paper_id, filter_key="cited_by", sort=sort, per_page=per_page
        )

    async def related_page(
        self,
        paper_id: str,
        *,
        filter_key: Literal["cites", "cited_by"],
        sort: str,
        cursor: str = "*",
        per_page: int = 200,
    ) -> RelatedPage:
        """One cursor page of the works related to ``paper_id`` (``cites`` →
        citers, ``cited_by`` → references) as compact entries. Cursor paging
        has no 10,000-result ceiling and keeps one stable traversal. A 404 is
        an empty, finished list; every other failure raises."""
        await self._limiter.acquire()
        params = _params()
        params["filter"] = f"{filter_key}:{_short_id(paper_id)}"
        params["sort"] = sort
        params["per_page"] = str(max(1, min(per_page, 200)))
        params["cursor"] = cursor
        params["select"] = _RELATED_SELECT
        resp = await self._client.get("/works", params=params)
        if resp.status_code == 404:
            return RelatedPage([], 0, None)
        resp.raise_for_status()
        data = resp.json()
        meta = data.get("meta") or {}
        return RelatedPage(
            entries=[_related_entry(w) for w in data.get("results") or []],
            count=int(meta.get("count") or 0),
            next_cursor=meta.get("next_cursor") or None,
        )

    async def works_by_ids(self, ids: list[str]) -> list[PaperMetadata]:
        """Full records for OpenAlex work ids, in input order (ids OpenAlex
        no longer returns, e.g. merged works, are skipped). Fetched in OR-filter
        batches of 50; errors raise."""
        wanted = list(dict.fromkeys(_short_id(i) for i in ids if i))
        found: dict[str, PaperMetadata] = {}
        for start in range(0, len(wanted), 50):
            chunk = wanted[start : start + 50]
            await self._limiter.acquire()
            params = _params()
            params["filter"] = "ids.openalex:" + "|".join(chunk)
            params["per_page"] = str(len(chunk))
            resp = await self._client.get("/works", params=params)
            if resp.status_code == 404:
                continue
            resp.raise_for_status()
            for raw in resp.json().get("results") or []:
                found[_short_id(raw.get("id"))] = _map_work(raw)
        return [found[i] for i in wanted if i in found]

    async def get_author(self, author_id: str) -> AuthorMetadata | None:
        await self._limiter.acquire()
        resp = await self._client.get(f"/authors/{author_id}", params=_params())
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json()
        return AuthorMetadata(
            name=data.get("display_name", ""),
            openalex_id=data.get("id"),
            orcid=data.get("orcid"),
            affiliations=[
                a.get("institution", {}).get("display_name", "")
                for a in data.get("affiliations", [])
                if a.get("institution", {}).get("display_name")
            ],
            works_count=data.get("works_count"),
            cited_by_count=data.get("cited_by_count"),
        )
