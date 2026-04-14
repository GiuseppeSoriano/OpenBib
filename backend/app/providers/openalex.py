"""OpenAlex provider implementation."""

from __future__ import annotations

from datetime import date

import httpx

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

    key = build_canonical_key(
        doi=doi,
        title=raw.get("title"),
        authors=[a.name for a in authors],
        year=raw.get("publication_year"),
    )

    return PaperMetadata(
        canonical_key=key,
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
    capabilities = {
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
        clean = doi.strip().removeprefix("https://doi.org/").removeprefix("http://doi.org/")
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
            filter_parts.append(
                f"authorships.author.display_name.search:{filters.author}"
            )
        if filters.venue:
            filter_parts.append(
                f"primary_location.source.display_name.search:{filters.venue}"
            )
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
