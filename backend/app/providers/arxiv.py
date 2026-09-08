"""arXiv provider implementation (Atom XML API)."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from contextlib import suppress
from datetime import date
from typing import ClassVar

import httpx

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

_BASE = "https://export.arxiv.org/api"

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}


def _text(el: ET.Element | None) -> str | None:
    return el.text.strip() if el is not None and el.text else None


def _extract_arxiv_id(id_url: str) -> str:
    """Extract arXiv ID from the full URL, e.g., http://arxiv.org/abs/2301.12345v2."""
    match = re.search(r"(\d{4}\.\d{4,5})(v\d+)?$", id_url)
    if match:
        return match.group(0)
    # Older format arXiv IDs (e.g., hep-th/0601234)
    match = re.search(r"([\w-]+/\d{7})(v\d+)?$", id_url)
    if match:
        return match.group(0)
    return id_url


def _parse_entry(entry: ET.Element) -> PaperMetadata:
    id_url = _text(entry.find("atom:id", _NS)) or ""
    arxiv_id = _extract_arxiv_id(id_url)

    title = _text(entry.find("atom:title", _NS)) or ""
    title = re.sub(r"\s+", " ", title)  # normalize whitespace

    abstract = _text(entry.find("atom:summary", _NS))

    authors: list[Author] = []
    for a in entry.findall("atom:author", _NS):
        name = _text(a.find("atom:name", _NS)) or ""
        aff_el = a.find("arxiv:affiliation", _NS)
        affiliations = [_text(aff_el)] if aff_el is not None and _text(aff_el) else []
        authors.append(Author(name=name, affiliations=affiliations))

    pub_date_str = _text(entry.find("atom:published", _NS))
    pub_date = None
    if pub_date_str:
        with suppress(ValueError):
            pub_date = date.fromisoformat(pub_date_str[:10])

    doi_el = entry.find("arxiv:doi", _NS)
    doi = _text(doi_el)

    venue = _text(entry.find("arxiv:journal_ref", _NS))

    primary_cat = entry.find("arxiv:primary_category", _NS)
    topics: list[str] = []
    if primary_cat is not None:
        term = primary_cat.get("term")
        if term:
            topics.append(term)
    for cat in entry.findall("atom:category", _NS):
        term = cat.get("term")
        if term and term not in topics:
            topics.append(term)

    pdf_url = None
    abstract_url = None
    for link in entry.findall("atom:link", _NS):
        if link.get("title") == "pdf":
            pdf_url = link.get("href")
        elif link.get("rel") == "alternate":
            abstract_url = link.get("href")

    # Detect version from id
    version_match = re.search(r"v(\d+)$", arxiv_id)
    version = f"v{version_match.group(1)}" if version_match else None

    key = build_canonical_key(
        doi=doi,
        title=title,
        authors=[a.name for a in authors],
        year=pub_date.year if pub_date else None,
    )

    return PaperMetadata(
        canonical_key=key,
        paper_group_key=build_paper_group_key(title, [a.name for a in authors]),
        title=title,
        authors=authors,
        abstract=abstract,
        publication_date=pub_date,
        doi=doi,
        arxiv_id=arxiv_id,
        venue=venue,
        topics=topics,
        pdf_url=pdf_url,
        abstract_url=abstract_url,
        version=version,
        provider_source="arxiv",
    )


class ArxivProvider(BaseProvider):
    name = "arxiv"
    capabilities: ClassVar[set[ProviderCapability]] = {
        ProviderCapability.LOOKUP_ID,
        ProviderCapability.SEARCH,
        ProviderCapability.VERSION_TRACKING,
        ProviderCapability.FULL_TEXT_LINK,
    }

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=15, follow_redirects=True)
        self._limiter = ProviderRateLimiter(calls_per_second=0.33, min_delay=3.0)

    async def lookup_by_doi(self, doi: str) -> PaperMetadata | None:
        # arXiv doesn't support DOI lookup directly
        return None

    async def lookup_by_id(self, provider_id: str) -> PaperMetadata | None:
        await self._limiter.acquire()
        resp = await self._client.get(f"{_BASE}/query", params={"id_list": provider_id})
        resp.raise_for_status()
        root = ET.fromstring(resp.text)
        entries = root.findall("atom:entry", _NS)
        if not entries:
            return None
        # Check if arXiv returned an error entry
        entry = entries[0]
        id_text = _text(entry.find("atom:id", _NS)) or ""
        if "api/errors" in id_text:
            return None
        return _parse_entry(entry)

    async def search(
        self, query: str, filters: SearchFilters, page: int = 1, size: int = 20
    ) -> SearchResult:
        await self._limiter.acquire()
        q_parts: list[str] = [f"all:{query}"]
        if filters.author:
            q_parts.append(f"au:{filters.author}")

        params = {
            "search_query": " AND ".join(q_parts),
            "start": (page - 1) * size,
            "max_results": min(size, 200),
            "sortBy": "relevance",
            "sortOrder": "descending",
        }
        resp = await self._client.get(f"{_BASE}/query", params=params)
        resp.raise_for_status()
        root = ET.fromstring(resp.text)

        total_el = root.find("opensearch:totalResults", _NS)
        total = int(_text(total_el) or "0")

        papers = [_parse_entry(e) for e in root.findall("atom:entry", _NS)]

        # Filter by year client-side (arXiv doesn't support year filter in API)
        if filters.year_from:
            papers = [
                p
                for p in papers
                if p.publication_date and p.publication_date.year >= filters.year_from
            ]
        if filters.year_to:
            papers = [
                p
                for p in papers
                if p.publication_date and p.publication_date.year <= filters.year_to
            ]

        return SearchResult(
            papers=papers,
            total_count=total,
            page=page,
            page_size=size,
            provider="arxiv",
        )

    async def get_references(self, paper_id: str) -> list[PaperReference]:
        # arXiv does not provide reference lists
        return []

    async def get_citations(self, paper_id: str) -> list[PaperReference]:
        # arXiv does not provide citation lists
        return []

    async def get_author(self, author_id: str) -> AuthorMetadata | None:
        # arXiv does not have author profiles
        return None
