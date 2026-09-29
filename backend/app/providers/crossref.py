"""Crossref provider implementation."""

from __future__ import annotations

import re
from datetime import date
from typing import ClassVar
from urllib.parse import quote

import httpx

from app.common.identifiers import strip_doi_prefixes
from app.common.text import clean_inline_text, normalize_abstract
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

_BASE = "https://api.crossref.org"

# Preprint servers encode the version in the DOI suffix: ``….v2`` or ``…/v2``.
_DOI_VERSION_RE = re.compile(r"[./]v(\d+)$", re.IGNORECASE)


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


def _pdf_link(raw: dict) -> str | None:
    """A PDF link only when it is openly licensed and meant for readers:
    publisher text-mining feeds and paywalled PDFs are not full text for users."""
    licenses = raw.get("license") or []
    if not any("creativecommons.org" in (lic.get("URL") or "").lower() for lic in licenses):
        return None
    for link in raw.get("link") or []:
        if (link.get("content-type") or "").lower() != "application/pdf":
            continue
        if (link.get("intended-application") or "").lower() == "text-mining":
            continue
        if link.get("URL"):
            return link["URL"]
    return None


def _preprint_server(raw: dict) -> str | None:
    institutions = raw.get("institution") or []
    if isinstance(institutions, list) and institutions and institutions[0].get("name"):
        return institutions[0]["name"]
    return raw.get("group-title") or None


def _map_work(raw: dict) -> PaperMetadata:
    doi = raw.get("DOI")
    # Keys are computed from the raw title; the stored title is cleaned.
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
                    aff.get("name", "") for aff in a.get("affiliation", []) if aff.get("name")
                ],
            )
        )

    # Hash keys keep using the print/online year so they stay byte-identical;
    # the displayed date also falls back to the posted and issued dates.
    key_date = _parse_date(raw.get("published-print")) or _parse_date(raw.get("published-online"))
    pub_date = key_date or _parse_date(raw.get("posted")) or _parse_date(raw.get("issued"))

    venue = (raw.get("container-title") or [""])[0] or None
    version = None
    if raw.get("type") == "posted-content" or raw.get("subtype") == "preprint":
        match = _DOI_VERSION_RE.search(doi or "")
        version = f"v{int(match.group(1))}" if match else None
        venue = venue or _preprint_server(raw)

    key = build_canonical_key(
        doi=doi,
        title=title,
        authors=[a.name for a in authors],
        year=key_date.year if key_date else None,
    )

    return PaperMetadata(
        canonical_key=key,
        paper_group_key=build_paper_group_key(title, [a.name for a in authors]),
        title=clean_inline_text(title),
        authors=authors,
        abstract=normalize_abstract(raw.get("abstract")),
        publication_date=pub_date,
        doi=doi,
        venue=venue,
        volume=raw.get("volume"),
        issue=raw.get("issue"),
        pages=raw.get("page"),
        paper_type=raw.get("type"),
        topics=raw.get("subject", []),
        cited_by_count=raw.get("is-referenced-by-count"),
        reference_count=raw.get("references-count"),
        pdf_url=_pdf_link(raw),
        version=version,
        provider_source="crossref",
        raw_response=raw,
    )


class CrossrefProvider(BaseProvider):
    name = "crossref"
    capabilities: ClassVar[set[ProviderCapability]] = {
        ProviderCapability.LOOKUP_DOI,
        ProviderCapability.SEARCH,
        ProviderCapability.REFERENCES,
    }

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(base_url=_BASE, timeout=15)
        self._limiter = ProviderRateLimiter(calls_per_second=50)

    async def lookup_by_doi(self, doi: str) -> PaperMetadata | None:
        await self._limiter.acquire()
        clean = quote(strip_doi_prefixes(doi), safe="/")
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
