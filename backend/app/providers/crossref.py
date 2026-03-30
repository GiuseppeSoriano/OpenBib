"""Crossref provider implementation."""

from __future__ import annotations

import re
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

_BASE = "https://api.crossref.org"

# Strip JATS XML tags from Crossref abstracts
_JATS_TAG_RE = re.compile(r"<[^>]+>")


def _strip_jats(text: str | None) -> str | None:
    if not text:
        return None
    return _JATS_TAG_RE.sub("", text).strip()


def _parse_date(raw: dict | None) -> date | None:
    """Parse Crossref date-parts format [[year, month, day]]."""
    if not raw:
        return None
    parts = raw.get("date-parts", [[]])[0]
    if not parts or parts[0] is None:
        return None
    year = parts[0]
    month = parts[1] if len(parts) > 1 and parts[1] else 1
    day = parts[2] if len(parts) > 2 and parts[2] else 1
    try:
        return date(year, month, day)
    except (ValueError, TypeError):
        return None


def _params() -> dict:
    p: dict[str, str] = {}
    if settings.crossref_mailto:
        p["mailto"] = settings.crossref_mailto
    return p


def _map_work(raw: dict) -> PaperMetadata:
    doi = raw.get("DOI")
    title = (raw.get("title") or [""])[0]

    authors: list[Author] = []
    for a in raw.get("author", []):
        given = a.get("given", "")
        family = a.get("family", "")
        name = f"{given} {family}".strip()
        orcid = a.get("ORCID")
        if orcid:
            orcid = orcid.removeprefix("http://orcid.org/").removeprefix("https://orcid.org/")
        authors.append(
            Author(
                name=name,
                family_name=family or None,
                given_name=given or None,
                orcid=orcid,
                affiliations=[
                    aff.get("name", "")
                    for aff in a.get("affiliation", [])
                    if aff.get("name")
                ],
            )
        )

    pub_date = _parse_date(raw.get("published-print")) or _parse_date(raw.get("published-online"))

    pdf_url = None
    for link in raw.get("link", []):
        if "pdf" in (link.get("content-type") or ""):
            pdf_url = link.get("URL")
            break

    key = build_canonical_key(
        doi=doi,
        title=title,
        authors=[a.name for a in authors],
        year=pub_date.year if pub_date else None,
    )

    return PaperMetadata(
        canonical_key=key,
        title=title,
        authors=authors,
        abstract=_strip_jats(raw.get("abstract")),
        publication_date=pub_date,
        doi=doi,
        venue=(raw.get("container-title") or [""])[0] or None,
        volume=raw.get("volume"),
        issue=raw.get("issue"),
        pages=raw.get("page"),
        paper_type=raw.get("type"),
        topics=raw.get("subject", []),
        cited_by_count=raw.get("is-referenced-by-count"),
        reference_count=raw.get("references-count"),
        pdf_url=pdf_url,
        provider_source="crossref",
        raw_response=raw,
    )


class CrossrefProvider(BaseProvider):
    name = "crossref"
    capabilities = {
        ProviderCapability.LOOKUP_DOI,
        ProviderCapability.SEARCH,
        ProviderCapability.REFERENCES,
    }

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(base_url=_BASE, timeout=15)
        self._limiter = ProviderRateLimiter(calls_per_second=50)

    async def lookup_by_doi(self, doi: str) -> PaperMetadata | None:
        await self._limiter.acquire()
        clean = doi.strip().removeprefix("https://doi.org/").removeprefix("http://doi.org/")
        resp = await self._client.get(f"/works/{clean}", params=_params())
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json()
        return _map_work(data.get("message", {}))

    async def lookup_by_id(self, provider_id: str) -> PaperMetadata | None:
        # Crossref only supports DOI lookup
        return await self.lookup_by_doi(provider_id)

    async def search(
        self, query: str, filters: SearchFilters, page: int = 1, size: int = 20
    ) -> SearchResult:
        await self._limiter.acquire()
        params = _params()
        params["query"] = query
        params["offset"] = str((page - 1) * size)
        params["rows"] = str(min(size, 1000))

        filter_parts: list[str] = []
        if filters.year_from:
            filter_parts.append(f"from-pub-date:{filters.year_from}")
        if filters.year_to:
            filter_parts.append(f"until-pub-date:{filters.year_to}")
        if filters.paper_type:
            filter_parts.append(f"type:{filters.paper_type}")
        if filter_parts:
            params["filter"] = ",".join(filter_parts)
        if filters.author:
            params["query.author"] = filters.author
        if filters.venue:
            params["query.container-title"] = filters.venue

        resp = await self._client.get("/works", params=params)
        resp.raise_for_status()
        data = resp.json().get("message", {})

        papers = [_map_work(item) for item in data.get("items", [])]
        return SearchResult(
            papers=papers,
            total_count=data.get("total-results", len(papers)),
            page=page,
            page_size=size,
            provider="crossref",
        )

    async def get_references(self, paper_id: str) -> list[PaperReference]:
        await self._limiter.acquire()
        resp = await self._client.get(f"/works/{paper_id}", params=_params())
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        data = resp.json().get("message", {})
        refs: list[PaperReference] = []
        for ref in data.get("reference", []):
            ref_doi = ref.get("DOI")
            if not ref_doi:
                continue
            key = build_canonical_key(doi=ref_doi)
            refs.append(
                PaperReference(
                    canonical_key=key,
                    title=ref.get("article-title"),
                    doi=ref_doi,
                    relation_type="references",
                )
            )
        return refs

    async def get_citations(self, paper_id: str) -> list[PaperReference]:
        # Crossref doesn't provide citation lists
        return []

    async def get_author(self, author_id: str) -> AuthorMetadata | None:
        # Crossref doesn't provide author profiles
        return None
