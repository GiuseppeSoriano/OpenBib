"""Semantic Scholar Academic Graph adapter. Raw API data never leaves this module."""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from typing import ClassVar
from urllib.parse import quote

import httpx
from fastapi import HTTPException

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
from app.providers.identity import deduplicate, normalize_arxiv, normalize_doi, normalize_text
from app.providers.rate_limiter import ProviderRateLimiter

BASE_URL = "https://api.semanticscholar.org/graph/v1"
# Shared by search, lookup and graph expansion: one canonical representation.
PAPER_FIELDS = (
    "title,abstract,authors,year,publicationDate,externalIds,venue,journal,"
    "url,isOpenAccess,openAccessPdf,citationCount,referenceCount,publicationTypes,fieldsOfStudy"
)
GRAPH_PAGE_SIZE = 1000
MAX_GRAPH_RECORDS = 10000


class ProviderError(HTTPException):
    """Sanitized error; never includes headers, response bodies or request objects."""

    def __init__(self, detail: str, status_code: int = 503, headers=None):
        super().__init__(status_code=status_code, detail=detail, headers=headers)


def _text(value) -> str | None:
    return value.strip() or None if isinstance(value, str) else None


def _list(value) -> list:
    return value if isinstance(value, list) else []


def _count(value) -> int | None:
    return value if type(value) is int and value >= 0 else None


def map_paper(raw: dict) -> PaperMetadata:
    if not isinstance(raw, dict) or not _text(raw.get("paperId")) or not _text(raw.get("title")):
        raise ProviderError("Semantic Scholar returned incomplete paper metadata.", 502)
    s2_id = raw["paperId"].strip().lower()
    title = raw["title"].strip()
    external = raw.get("externalIds") or {}
    external = external if isinstance(external, dict) else {}
    doi = normalize_doi(external["DOI"]) if _text(external.get("DOI")) else None
    arxiv = normalize_arxiv(external["ArXiv"]) if _text(external.get("ArXiv")) else None
    authors = [
        Author(name=a["name"].strip(), semantic_scholar_id=_text(a.get("authorId")))
        for a in _list(raw.get("authors"))
        if isinstance(a, dict) and _text(a.get("name"))
    ]
    published = None
    try:
        published = date.fromisoformat(raw["publicationDate"])
    except (ValueError, TypeError, KeyError):
        year = raw.get("year")
        if type(year) is int and 1 <= year <= 9999:
            published = date(year, 1, 1)  # Existing model represents year-only dates this way.
    journal = raw.get("journal") or {}
    journal = journal if isinstance(journal, dict) else {}
    pdf = raw.get("openAccessPdf") or {}
    pdf = pdf if isinstance(pdf, dict) else {}
    types = _list(raw.get("publicationTypes"))
    # Keep the existing domain vocabulary used by Zotero and version labels.
    type_map = {
        "BookSection": "book-chapter",
        "Book": "book",
        "Conference": "conference-paper",
        "Dataset": "dataset",
        "Review": "review",
        "JournalArticle": "journal-article",
    }
    paper_type = next((value for kind, value in type_map.items() if kind in types), None)
    if arxiv and (not doi or doi.startswith("10.48550/arxiv.")):
        paper_type = "preprint"
    return PaperMetadata(
        canonical_key=build_canonical_key(doi=doi) if doi else f"s2:{s2_id}",
        paper_group_key=build_paper_group_key(title, [a.name for a in authors]),
        semantic_scholar_id=s2_id,
        title=title,
        authors=authors,
        abstract=_text(raw.get("abstract")),
        publication_date=published,
        doi=doi,
        arxiv_id=arxiv,
        pmid=_text(external.get("PubMed")),
        pmcid=_text(external.get("PubMedCentral")),
        venue=_text(raw.get("venue")) or _text(journal.get("name")),
        volume=_text(journal.get("volume")),
        pages=_text(journal.get("pages")),
        paper_type=paper_type,
        topics=[t for t in _list(raw.get("fieldsOfStudy")) if isinstance(t, str)],
        open_access=raw.get("isOpenAccess") if isinstance(raw.get("isOpenAccess"), bool) else None,
        pdf_url=_text(pdf.get("url")),
        abstract_url=_text(raw.get("url")),
        cited_by_count=_count(raw.get("citationCount")),
        reference_count=_count(raw.get("referenceCount")),
        provider_source="semantic_scholar",
        provider_sources=["semantic_scholar"],
    )


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    value = response.headers.get("Retry-After") if response is not None else None
    if value:
        try:
            delay = float(value)
        except ValueError:
            try:
                delay = (parsedate_to_datetime(value) - datetime.now(UTC)).total_seconds()
            except (ValueError, TypeError, OverflowError):
                delay = 0
        if delay > 30:
            # Do not retry earlier than the server permits or block a request for minutes.
            raise ProviderError(
                "Semantic Scholar is rate limited; retry later.",
                headers={"Retry-After": str(int(delay))},
            )
        return max(0, delay)
    return float((5 if response is not None and response.status_code == 429 else 1) * 2**attempt)


class SemanticScholarProvider(BaseProvider):
    name = "semantic_scholar"
    capabilities: ClassVar = {
        ProviderCapability.SEARCH,
        ProviderCapability.LOOKUP_DOI,
        ProviderCapability.LOOKUP_ID,
        ProviderCapability.REFERENCES,
        ProviderCapability.CITATIONS,
        ProviderCapability.FULL_TEXT_LINK,
    }

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None):
        self._client = httpx.AsyncClient(base_url=BASE_URL, timeout=20, transport=transport)
        self._limiter = ProviderRateLimiter(calls_per_second=1, min_delay=2.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def _get(self, path: str, params: dict, *, missing_ok: bool = False) -> dict | None:
        key = settings.semantic_scholar_api_key.get_secret_value().strip()
        if not key:
            raise ProviderError("Configure SEMANTIC_SCHOLAR_API_KEY to retrieve papers.")
        for attempt in range(3):
            await self._limiter.acquire()
            response = None
            try:
                response = await self._client.get(path, params=params, headers={"x-api-key": key})
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise ProviderError("Semantic Scholar is unavailable; please retry.") from None
            else:
                code = response.status_code
                if code in (401, 403):
                    raise ProviderError(
                        "Semantic Scholar rejected SEMANTIC_SCHOLAR_API_KEY; check the configured credential."
                    )
                if code == 404 and missing_ok:
                    return None
                if code == 400 and path == "/paper/search" and params.get("offset", 0) > 0:
                    # The live API uses this exact 400 for pages beyond the available
                    # matches (even within its 1,000-result window).
                    try:
                        exhausted = response.json().get("error") == (
                            "Requested data for this limit and/or offset is not available"
                        )
                    except (ValueError, AttributeError):
                        exhausted = False
                    if exhausted:
                        return {"data": [], "total": 0}
                if code == 429 or 500 <= code < 600:
                    if attempt == 2:
                        raise ProviderError(
                            "Semantic Scholar is busy; please retry.",
                            headers={
                                "Retry-After": str(int(max(30, _retry_delay(response, attempt))))
                            },
                        )
                elif code >= 400:
                    raise ProviderError(
                        "Semantic Scholar could not process this paper query.",
                        422 if code == 400 else 502,
                    )
                else:
                    try:
                        data = response.json()
                    except ValueError:
                        raise ProviderError(
                            "Semantic Scholar returned invalid JSON.", 502
                        ) from None
                    if not isinstance(data, dict):
                        raise ProviderError("Semantic Scholar returned an invalid response.", 502)
                    return data
            await asyncio.sleep(_retry_delay(response, attempt))
        raise AssertionError("unreachable")

    async def lookup_by_doi(self, doi: str) -> PaperMetadata | None:
        return await self.lookup_by_id("DOI:" + normalize_doi(doi))

    async def lookup_by_id(self, provider_id: str) -> PaperMetadata | None:
        identifier = provider_id.removeprefix("s2:")
        prefix, sep, value = identifier.partition(":")
        if prefix.lower() == "arxiv" and sep:
            identifier = "ARXIV:" + normalize_arxiv(value)
        elif prefix.lower() == "doi" and sep:
            identifier = "DOI:" + normalize_doi(value)
        elif prefix.lower() in ("pmid", "pmcid") and sep:
            identifier = prefix.upper() + ":" + value
        data = await self._get(
            "/paper/" + quote(identifier, safe=""), {"fields": PAPER_FIELDS}, missing_ok=True
        )
        return map_paper(data) if data is not None else None

    @staticmethod
    def _page(data: dict) -> tuple[list, int | None]:
        rows, next_offset = data.get("data"), data.get("next")
        if not isinstance(rows, list) or (next_offset is not None and type(next_offset) is not int):
            raise ProviderError("Semantic Scholar returned invalid pagination.", 502)
        return rows, next_offset

    async def search(
        self, query: str, filters: SearchFilters, page: int = 1, size: int = 20
    ) -> SearchResult:
        offset = (page - 1) * size
        if page < 1 or not 1 <= size <= 100 or offset >= 1000:
            raise ProviderError(
                "Search supports page sizes 1–100 and the first 1,000 results.", 422
            )
        if filters.year_from and filters.year_to and filters.year_from > filters.year_to:
            raise ProviderError("year_from must not exceed year_to.", 422)
        params = {
            "query": query.replace("-", " "),
            "fields": PAPER_FIELDS,
            "offset": offset,
            "limit": min(size, 1000 - offset),
        }
        if filters.year_from or filters.year_to:
            params["year"] = f"{filters.year_from or ''}-{filters.year_to or ''}"
        if filters.open_access_only:
            params["openAccessPdf"] = ""
        if filters.venue:
            params["venue"] = filters.venue
        if filters.paper_type:
            params["publicationTypes"] = filters.paper_type
        data = await self._get("/paper/search", params)
        rows, _ = self._page(data)
        papers = deduplicate([map_paper(row) for row in rows])
        # No upstream author-name filter exists. This filters the requested ranked
        # page only; it is deliberately not an expensive author search/join.
        if filters.author:
            author = normalize_text(filters.author)
            papers = [p for p in papers if any(author in normalize_text(a.name) for a in p.authors)]
        return SearchResult(
            papers=papers,
            total_count=_count(data.get("total")) or 0,
            page=page,
            page_size=size,
            provider=self.name,
        )

    async def _graph_rows(self, paper_id: str, direction: str, fields: str) -> list[dict]:
        offset = 0
        papers = []
        nested = "citedPaper" if direction == "references" else "citingPaper"
        while True:
            data = await self._get(
                f"/paper/{quote(paper_id.removeprefix('s2:'), safe='')}/{direction}",
                {"fields": fields, "offset": offset, "limit": GRAPH_PAGE_SIZE},
                missing_ok=True,
            )
            if data is None:
                return []
            rows, next_offset = self._page(data)
            for row in rows:
                if not isinstance(row, dict) or nested not in row:
                    raise ProviderError("Semantic Scholar returned invalid citation data.", 502)
                # Unresolved graph nodes have null paperId. They cannot form an edge.
                paper = row[nested]
                if isinstance(paper, dict) and _text(paper.get("paperId")):
                    papers.append(paper)
            if next_offset is None:
                return papers
            if not rows or next_offset <= offset:
                raise ProviderError("Semantic Scholar returned non-advancing pagination.", 502)
            if next_offset >= MAX_GRAPH_RECORDS:
                raise ProviderError(
                    "This paper exceeds the 10,000-record graph traversal limit.", 422
                )
            offset = next_offset

    async def list_related_papers(
        self, paper_id: str, *, direction: str, order: str, limit: int
    ) -> list[PaperMetadata]:
        papers = deduplicate(
            [map_paper(row) for row in await self._graph_rows(paper_id, direction, PAPER_FIELDS)]
        )
        if order == "recent":
            papers.sort(
                key=lambda p: (-(p.publication_date or date.min).toordinal(), p.canonical_key)
            )
        else:
            papers.sort(key=lambda p: (-(p.cited_by_count or 0), p.canonical_key))
        return papers[:limit]

    async def reference_ids(self, paper_id: str) -> list[str]:
        rows = await self._graph_rows(paper_id, "references", "paperId")
        return sorted({row["paperId"].lower() for row in rows})

    async def get_references(self, paper_id: str) -> list[PaperReference]:
        papers = await self.list_related_papers(
            paper_id, direction="references", order="cited_by_count", limit=MAX_GRAPH_RECORDS
        )
        return [PaperReference(p.canonical_key, p.title, p.doi) for p in papers]

    async def get_citations(self, paper_id: str) -> list[PaperReference]:
        papers = await self.list_related_papers(
            paper_id, direction="citations", order="cited_by_count", limit=MAX_GRAPH_RECORDS
        )
        return [PaperReference(p.canonical_key, p.title, p.doi, "cited_by") for p in papers]

    async def get_author(self, author_id: str) -> AuthorMetadata | None:
        # No application caller needs an author profile. Names/IDs arrive with papers.
        raise NotImplementedError("Author profiles are not used by the application")
