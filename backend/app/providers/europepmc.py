"""Europe PMC provider implementation."""

from __future__ import annotations

from datetime import date
from typing import ClassVar

import httpx

from app.common.identifiers import strip_doi_prefixes
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

_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"


def _parse_date(raw: str | None) -> date | None:
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def _parse_authors(raw: dict) -> list[Author]:
    """Parse authors from Europe PMC response."""
    # Try detailed author list first (core result type)
    author_list = raw.get("authorList", {}).get("author", [])
    if author_list:
        authors = []
        for a in author_list:
            name = f"{a.get('firstName', '')} {a.get('lastName', '')}".strip()
            if not name:
                name = a.get("fullName", "")
            affiliations = []
            aff_info = a.get("authorAffiliationDetailsList", {}).get("authorAffiliation", [])
            for aff in aff_info:
                if aff.get("affiliation"):
                    affiliations.append(aff["affiliation"])
            authors.append(
                Author(
                    name=name,
                    family_name=a.get("lastName"),
                    given_name=a.get("firstName"),
                    orcid=a.get("authorId", {}).get("value")
                    if a.get("authorId", {}).get("type") == "ORCID"
                    else None,
                    affiliations=affiliations,
                )
            )
        return authors

    # Fallback: parse authorString (comma-separated)
    author_string = raw.get("authorString", "")
    if author_string:
        return [Author(name=n.strip()) for n in author_string.split(",") if n.strip()]
    return []


def _map_result(raw: dict) -> PaperMetadata:
    doi = raw.get("doi")
    title = raw.get("title", "")
    authors = _parse_authors(raw)
    pub_date = _parse_date(raw.get("firstPublicationDate"))

    key = build_canonical_key(
        doi=doi,
        title=title,
        authors=[a.name for a in authors],
        year=pub_date.year if pub_date else None,
    )

    # Extract PDF/abstract URLs
    pdf_url = None
    abstract_url = None
    for ft in raw.get("fullTextUrlList", {}).get("fullTextUrl", []):
        availability = ft.get("availabilityCode", "")
        doc_style = ft.get("documentStyle", "")
        if doc_style == "pdf" and availability == "OA":
            pdf_url = ft.get("url")
        elif doc_style == "html":
            abstract_url = ft.get("url")

    topics: list[str] = []
    for mesh in raw.get("meshHeadingList", {}).get("meshHeading", []):
        desc = mesh.get("descriptorName")
        if desc:
            topics.append(desc)

    keywords: list[str] = raw.get("keywordList", {}).get("keyword", [])

    return PaperMetadata(
        canonical_key=key,
        paper_group_key=build_paper_group_key(title, [a.name for a in authors]),
        title=title,
        authors=authors,
        abstract=raw.get("abstractText"),
        publication_date=pub_date,
        doi=doi,
        pmid=raw.get("pmid"),
        pmcid=raw.get("pmcid"),
        venue=raw.get("journalTitle"),
        volume=raw.get("journalVolume"),
        issue=raw.get("issue"),
        pages=raw.get("pageInfo"),
        paper_type=raw.get("pubType"),
        topics=topics,
        keywords=keywords,
        open_access=raw.get("isOpenAccess") == "Y",
        pdf_url=pdf_url,
        abstract_url=abstract_url,
        cited_by_count=raw.get("citedByCount"),
        provider_source="europepmc",
        raw_response=raw,
    )


class EuropePMCProvider(BaseProvider):
    name = "europepmc"
    capabilities: ClassVar[set[ProviderCapability]] = {
        ProviderCapability.LOOKUP_DOI,
        ProviderCapability.LOOKUP_ID,
        ProviderCapability.SEARCH,
        ProviderCapability.REFERENCES,
        ProviderCapability.CITATIONS,
        ProviderCapability.FULL_TEXT_LINK,
    }

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(base_url=_BASE, timeout=15)
        self._limiter = ProviderRateLimiter(calls_per_second=10)

    async def lookup_by_doi(self, doi: str) -> PaperMetadata | None:
        await self._limiter.acquire()
        # A stray quote would break out of the phrase query.
        clean = strip_doi_prefixes(doi).replace('"', "")
        params = {
            "query": f'DOI:"{clean}"',
            "format": "json",
            "resultType": "core",
            "pageSize": "1",
        }
        resp = await self._client.get("/search", params=params)
        resp.raise_for_status()
        data = resp.json()
        results = data.get("resultList", {}).get("result", [])
        if not results:
            return None
        return _map_result(results[0])

    async def lookup_by_id(self, provider_id: str) -> PaperMetadata | None:
        await self._limiter.acquire()
        # Assume provider_id is a PMID
        params = {
            "query": f"EXT_ID:{provider_id} SRC:MED",
            "format": "json",
            "resultType": "core",
            "pageSize": "1",
        }
        resp = await self._client.get("/search", params=params)
        resp.raise_for_status()
        data = resp.json()
        results = data.get("resultList", {}).get("result", [])
        if not results:
            return None
        return _map_result(results[0])

    async def search(
        self, query: str, filters: SearchFilters, page: int = 1, size: int = 20
    ) -> SearchResult:
        await self._limiter.acquire()
        q_parts: list[str] = [query]
        if filters.author:
            q_parts.append(f'AUTH:"{filters.author}"')
        if filters.year_from and filters.year_to:
            q_parts.append(f"PUB_YEAR:[{filters.year_from} TO {filters.year_to}]")
        elif filters.year_from:
            q_parts.append(f"PUB_YEAR:[{filters.year_from} TO 2099]")
        elif filters.year_to:
            q_parts.append(f"PUB_YEAR:[1900 TO {filters.year_to}]")
        if filters.open_access_only:
            q_parts.append("OPEN_ACCESS:y")

        params = {
            "query": " AND ".join(q_parts),
            "format": "json",
            "resultType": "core",
            "pageSize": str(min(size, 1000)),
            "cursorMark": "*",
        }
        resp = await self._client.get("/search", params=params)
        resp.raise_for_status()
        data = resp.json()

        results = data.get("resultList", {}).get("result", [])
        papers = [_map_result(r) for r in results]
        return SearchResult(
            papers=papers,
            total_count=data.get("hitCount", len(papers)),
            page=page,
            page_size=size,
            provider="europepmc",
        )

    async def get_references(self, paper_id: str) -> list[PaperReference]:
        await self._limiter.acquire()
        resp = await self._client.get(
            f"/MED/{paper_id}/references",
            params={"format": "json", "pageSize": "100"},
        )
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        data = resp.json()
        refs: list[PaperReference] = []
        for ref in data.get("referenceList", {}).get("reference", []):
            doi = ref.get("doi")
            title = ref.get("title")
            key = build_canonical_key(doi=doi, title=title)
            refs.append(
                PaperReference(canonical_key=key, title=title, doi=doi, relation_type="references")
            )
        return refs

    async def get_citations(self, paper_id: str) -> list[PaperReference]:
        await self._limiter.acquire()
        resp = await self._client.get(
            f"/MED/{paper_id}/citations",
            params={"format": "json", "pageSize": "100"},
        )
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        data = resp.json()
        cites: list[PaperReference] = []
        for cit in data.get("citationList", {}).get("citation", []):
            doi = cit.get("doi")
            title = cit.get("title")
            key = build_canonical_key(doi=doi, title=title)
            cites.append(
                PaperReference(canonical_key=key, title=title, doi=doi, relation_type="cited_by")
            )
        return cites

    async def get_author(self, author_id: str) -> AuthorMetadata | None:
        # Europe PMC doesn't have dedicated author profile endpoints
        return None
