"""Semantic Scholar Academic Graph adapter. Raw API data never leaves this module."""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from typing import Any, ClassVar, Literal
from urllib.parse import quote

import httpx
from fastapi import status

from app.common.exceptions import ApiError
from app.common.identifiers import synthetic_group_key
from app.common.text import clean_inline_text, normalize_abstract
from app.config import settings
from app.providers.base import (
    Author,
    AuthorMetadata,
    BaseProvider,
    BulkSearchPage,
    PaperMetadata,
    PaperReference,
    ProviderCapability,
    RelatedPage,
    SearchFilters,
    SearchResult,
    build_canonical_key,
    build_paper_group_key,
)
from app.providers.identity import deduplicate, normalize_arxiv, normalize_doi, normalize_text
from app.providers.rate_limiter import ProviderRateLimiter

logger = logging.getLogger(__name__)

BASE_URL = "https://api.semanticscholar.org/graph/v1"
# Shared by search, lookup and batch lookup: one canonical representation.
PAPER_FIELDS = (
    "title,abstract,authors,year,publicationDate,externalIds,venue,journal,"
    "url,isOpenAccess,openAccessPdf,citationCount,referenceCount,publicationTypes,fieldsOfStudy"
)
# Related-list scans: every key input of ``related_entry`` plus the ranking
# fields, never abstracts.
RELATED_FIELDS = "paperId,title,authors,year,publicationDate,externalIds,citationCount"
GRAPH_PAGE_SIZE = 1000
# Citation and reference paging requires ``offset + limit < 10000``.
MAX_GRAPH_RECORDS = 10000
# Relevance search requires ``offset + limit < 1000``.
SEARCH_WINDOW = 1000
# ``POST /paper/batch`` accepts at most 500 ids per call.
BATCH_SIZE = 500
BULK_SORTS = ("citationCount:desc", "publicationDate:desc")
# Semantic Scholar sends no Retry-After with its 429s: clients wait this long.
DEFAULT_RETRY_AFTER = 30
# Backoff base for those header-less 429s (2 s, then 4 s): a rate-limited
# lookup gives up well inside ``doi_resolve_timeout_seconds``.
RATE_LIMIT_BACKOFF = 2
# Bulk search reads these as boolean operators; queries stay plain words.
_BULK_OPERATORS_RE = re.compile(r'[+|\-"*()~]')
_EXHAUSTED_PAGE = "Requested data for this limit and/or offset is not available"
# ``POST /paper/batch`` answers this 400 when none of the ids matches a paper
# (a batch with at least one match has ``null`` rows for the misses instead).
_NO_BATCH_MATCH = "No valid paper ids given"

ProviderErrorCode = Literal[
    "provider_not_configured",
    "provider_key_rejected",
    "provider_rate_limited",
    "provider_unavailable",
    "provider_bad_response",
    "invalid_query",
    "search_window_exceeded",
]


class ProviderError(ApiError):
    """Sanitized error with a machine-readable ``code``; never includes
    headers, response bodies or request objects. ``retry_after`` (seconds)
    is sent as ``Retry-After`` and repeated in the detail."""

    def __init__(
        self,
        code: ProviderErrorCode,
        message: str,
        status_code: int = status.HTTP_503_SERVICE_UNAVAILABLE,
        *,
        retry_after: int | None = None,
    ):
        extra = {} if retry_after is None else {"retry_after": retry_after}
        headers = None if retry_after is None else {"Retry-After": str(retry_after)}
        super().__init__(status_code, code, message, headers=headers, **extra)
        self.retry_after = retry_after


def _bad_response(message: str = "Semantic Scholar returned an invalid response.") -> ProviderError:
    return ProviderError("provider_bad_response", message, status.HTTP_502_BAD_GATEWAY)


def _text(value) -> str | None:
    return value.strip() or None if isinstance(value, str) else None


def _list(value) -> list:
    return value if isinstance(value, list) else []


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _count(value) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _doi(raw: dict) -> str | None:
    external = _dict(raw.get("externalIds"))
    return normalize_doi(external["DOI"]) if _text(external.get("DOI")) else None


def _canonical_key(s2_id: str, doi: str | None) -> str:
    return build_canonical_key(doi=doi) if doi else f"s2:{s2_id}"


def _authors(raw: dict) -> list[Author]:
    return [
        Author(name=a["name"].strip(), semantic_scholar_id=_text(a.get("authorId")))
        for a in _list(raw.get("authors"))
        if isinstance(a, dict) and _text(a.get("name"))
    ]


def _published(raw: dict) -> date | None:
    try:
        return date.fromisoformat(raw["publicationDate"])
    except (ValueError, TypeError, KeyError):
        year = raw.get("year")
        if type(year) is int and 1 <= year <= 9999:
            return date(year, 1, 1)  # Existing model represents year-only dates this way.
    return None


def related_entry(raw: dict) -> list:
    """Compact related-list entry ``[s2_id, canonical_key, group_key,
    date_ordinal, cited_by]``. Keys match what ``map_paper`` gives the same
    record; an untitled record gets a synthetic group. Needs a ``paperId``."""
    s2_id = raw["paperId"].strip().lower()
    canonical_key = _canonical_key(s2_id, _doi(raw))
    title = _text(raw.get("title"))
    group_key = (
        build_paper_group_key(title, [a.name for a in _authors(raw)])
        if title
        else synthetic_group_key(canonical_key)
    )
    published = _published(raw)
    return [
        s2_id,
        canonical_key,
        group_key,
        published.toordinal() if published else None,
        _count(raw.get("citationCount")),
    ]


def map_paper(raw: dict) -> PaperMetadata:
    if not isinstance(raw, dict) or not _text(raw.get("paperId")) or not _text(raw.get("title")):
        raise _bad_response("Semantic Scholar returned incomplete paper metadata.")
    s2_id = raw["paperId"].strip().lower()
    # Keys come from the raw title; the stored title and abstract are plain text.
    raw_title = raw["title"].strip()
    external = _dict(raw.get("externalIds"))
    doi = _doi(raw)
    arxiv = normalize_arxiv(external["ArXiv"]) if _text(external.get("ArXiv")) else None
    # Semantic Scholar stores the bare number; ``pmcid:`` keys use ``PMC<digits>``.
    pmcid = _text(external.get("PubMedCentral"))
    if pmcid:
        pmcid = f"PMC{pmcid}" if pmcid.isdigit() else pmcid.upper()
    authors = _authors(raw)
    journal = _dict(raw.get("journal"))
    pdf = _dict(raw.get("openAccessPdf"))
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
        canonical_key=_canonical_key(s2_id, doi),
        paper_group_key=build_paper_group_key(raw_title, [a.name for a in authors]),
        semantic_scholar_id=s2_id,
        title=clean_inline_text(raw_title) or raw_title,
        authors=authors,
        abstract=normalize_abstract(_text(raw.get("abstract"))),
        publication_date=_published(raw),
        doi=doi,
        arxiv_id=arxiv,
        pmid=_text(external.get("PubMed")),
        pmcid=pmcid,
        venue=_text(raw.get("venue")) or _text(journal.get("name")),
        volume=_text(journal.get("volume")),
        pages=_text(journal.get("pages")),
        paper_type=paper_type,
        topics=[t for t in _list(raw.get("fieldsOfStudy")) if isinstance(t, str)],
        open_access=raw.get("isOpenAccess") if isinstance(raw.get("isOpenAccess"), bool) else None,
        # An empty ``url`` (a disclaimer only) means no open-access copy.
        pdf_url=_text(pdf.get("url")),
        # Always the semanticscholar.org landing page, never full text.
        abstract_url=_text(raw.get("url")),
        cited_by_count=_count(raw.get("citationCount")),
        reference_count=_count(raw.get("referenceCount")),
        provider_source="semantic_scholar",
        provider_sources=["semantic_scholar"],
    )


def _map_or_none(row) -> PaperMetadata | None:
    """``map_paper``, or ``None`` for an incomplete record (no ``paperId`` or
    title): one such record must not fail a whole page or batch."""
    try:
        return map_paper(row)
    except ProviderError:
        logger.warning("Semantic Scholar returned an incomplete record")
        return None


def _map_rows(rows: list) -> list[PaperMetadata]:
    return [paper for row in rows if (paper := _map_or_none(row)) is not None]


def _rate_limited(retry_after: float = DEFAULT_RETRY_AFTER) -> ProviderError:
    return ProviderError(
        "provider_rate_limited",
        "Semantic Scholar is rate limiting requests; retry later.",
        retry_after=max(1, int(retry_after)),
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
            raise _rate_limited(delay)
        return max(0, delay)
    rate_limited = response is not None and response.status_code == 429
    return float((RATE_LIMIT_BACKOFF if rate_limited else 1) * 2**attempt)


def _upstream_error(response: httpx.Response) -> str:
    """The short ``error`` message of a 400, for matching only (never exposed)."""
    try:
        data = response.json()
    except ValueError:
        return ""
    return (
        data.get("error") if isinstance(data, dict) and isinstance(data.get("error"), str) else ""
    )


def s2_identifier(provider_id: str) -> str:
    """Path form of an id: a bare paperId, or ``DOI:``/``ARXIV:``/``PMID:``/
    ``PMCID:`` plus the normalized value (``s2:`` keys lose their prefix)."""
    identifier = provider_id.strip().removeprefix("s2:")
    prefix, sep, value = identifier.partition(":")
    if not sep:
        return identifier
    kind = prefix.lower()
    if kind == "arxiv":
        return "ARXIV:" + normalize_arxiv(value)
    if kind == "doi":
        return "DOI:" + normalize_doi(value)
    if kind == "pmcid":
        # Semantic Scholar takes the numeric part (``PMCID:2323736``).
        value = value.strip()
        return "PMCID:" + (value[3:] if value.upper().startswith("PMC") else value)
    if kind == "pmid":
        return "PMID:" + value.strip()
    return identifier


def _paper_path(provider_id: str) -> str:
    # Only the value is percent-encoded; the ``DOI:`` prefix stays literal.
    prefix, sep, value = s2_identifier(provider_id).partition(":")
    return "/paper/" + (prefix + ":" + quote(value, safe="") if sep else quote(prefix, safe=""))


def sanitize_bulk_query(query: str) -> str:
    """Plain words for bulk search, which reads ``+ | - " * ( ) ~`` as syntax."""
    return " ".join(_BULK_OPERATORS_RE.sub(" ", query).split())


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
        # Retry backoff; tests replace it to skip the waits.
        self._sleep = asyncio.sleep

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        json: Any = None,
        *,
        missing_ok: bool = False,
        exhausted_ok: bool = False,
        none_found_ok: bool = False,
    ) -> Any:
        """One API call under the shared key, pacing and retry policy. Returns
        the decoded JSON, or ``None`` for a 404 when ``missing_ok``, for a
        page past the last match when ``exhausted_ok`` and for a batch that
        matched no paper when ``none_found_ok``."""
        key = settings.semantic_scholar_api_key.get_secret_value().strip()
        if not key:
            raise ProviderError(
                "provider_not_configured", "Configure SEMANTIC_SCHOLAR_API_KEY to retrieve papers."
            )
        for attempt in range(3):
            await self._limiter.acquire()
            response = None
            try:
                response = await self._client.request(
                    method, path, params=params, json=json, headers={"x-api-key": key}
                )
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise ProviderError(
                        "provider_unavailable", "Semantic Scholar is unavailable; please retry."
                    ) from None
            else:
                code = response.status_code
                if code in (401, 403):
                    raise ProviderError(
                        "provider_key_rejected",
                        "Semantic Scholar rejected SEMANTIC_SCHOLAR_API_KEY; check the configured credential.",
                    )
                if code == 404 and missing_ok:
                    return None
                if code == 400:
                    error = _upstream_error(response)
                    # The live API uses this exact 400 for pages beyond the
                    # available matches (even within its 1,000-result window).
                    if exhausted_ok and error == _EXHAUSTED_PAGE:
                        return None
                    if none_found_ok and error == _NO_BATCH_MATCH:
                        return None
                    if "offset + limit must be <" in error:
                        raise ProviderError(
                            "search_window_exceeded",
                            "Semantic Scholar serves only the first results of a query.",
                            status.HTTP_422_UNPROCESSABLE_CONTENT,
                        )
                    raise ProviderError(
                        "invalid_query",
                        "Semantic Scholar could not process this paper query.",
                        status.HTTP_422_UNPROCESSABLE_CONTENT,
                    )
                if code == 429 or 500 <= code < 600:
                    if attempt == 2:
                        delay = max(DEFAULT_RETRY_AFTER, _retry_delay(response, attempt))
                        if code == 429:
                            raise _rate_limited(delay)
                        raise ProviderError(
                            "provider_unavailable",
                            "Semantic Scholar is busy; please retry.",
                            retry_after=int(delay),
                        )
                elif code >= 400:
                    raise _bad_response("Semantic Scholar could not process this paper query.")
                else:
                    try:
                        return response.json()
                    except ValueError:
                        raise _bad_response("Semantic Scholar returned invalid JSON.") from None
            await self._sleep(_retry_delay(response, attempt))
        raise AssertionError("unreachable")

    async def _get(
        self, path: str, params: dict, *, missing_ok: bool = False, exhausted_ok: bool = False
    ) -> dict | None:
        data = await self._request(
            "GET", path, params, missing_ok=missing_ok, exhausted_ok=exhausted_ok
        )
        if data is not None and not isinstance(data, dict):
            raise _bad_response()
        return data

    async def _batch(self, provider_ids: list[str], fields: str) -> list[dict | None]:
        """``POST /paper/batch`` per ``BATCH_SIZE`` ids: one raw record per id
        in input order, ``None`` for a miss."""
        rows: list[dict | None] = []
        for start in range(0, len(provider_ids), BATCH_SIZE):
            chunk = [s2_identifier(i) for i in provider_ids[start : start + BATCH_SIZE]]
            data = await self._request(
                "POST", "/paper/batch", {"fields": fields}, {"ids": chunk}, none_found_ok=True
            )
            if data is None:
                rows.extend([None] * len(chunk))
                continue
            if (
                not isinstance(data, list)
                or len(data) != len(chunk)
                or any(row is not None and not isinstance(row, dict) for row in data)
            ):
                raise _bad_response()
            rows.extend(data)
        return rows

    async def lookup_by_doi(self, doi: str) -> PaperMetadata | None:
        return await self.lookup_by_id("DOI:" + normalize_doi(doi))

    async def lookup_by_id(self, provider_id: str) -> PaperMetadata | None:
        data = await self._get(_paper_path(provider_id), {"fields": PAPER_FIELDS}, missing_ok=True)
        return map_paper(data) if data is not None else None

    async def lookup_many(self, provider_ids: list[str]) -> list[PaperMetadata | None]:
        # An incomplete record is a miss, like a null row.
        return [
            _map_or_none(row) if row is not None else None
            for row in await self._batch(provider_ids, PAPER_FIELDS)
        ]

    async def references_batch(self, paper_ids: list[str]) -> list[list[str] | None]:
        """Sorted reference paperIds of each paper (input order, ``None`` for a
        miss) from one batch call per ``BATCH_SIZE`` ids. Unresolved
        references (null ``paperId``) cannot form an edge and are skipped."""
        return [
            None
            if row is None
            else sorted(
                {
                    ref["paperId"].strip().lower()
                    for ref in _list(row.get("references"))
                    if isinstance(ref, dict) and _text(ref.get("paperId"))
                }
            )
            for row in await self._batch(paper_ids, "paperId,references.paperId")
        ]

    @staticmethod
    def _page(data: dict) -> tuple[list, int | None]:
        rows, next_offset = data.get("data"), data.get("next")
        if not isinstance(rows, list) or (next_offset is not None and type(next_offset) is not int):
            raise _bad_response("Semantic Scholar returned invalid pagination.")
        return rows, next_offset

    @staticmethod
    def _filter_params(filters: SearchFilters) -> dict:
        if filters.year_from and filters.year_to and filters.year_from > filters.year_to:
            raise ProviderError(
                "invalid_query",
                "year_from must not exceed year_to.",
                status.HTTP_422_UNPROCESSABLE_CONTENT,
            )
        params: dict = {}
        if filters.year_from or filters.year_to:
            params["year"] = f"{filters.year_from or ''}-{filters.year_to or ''}"
        if filters.open_access_only:
            params["openAccessPdf"] = ""
        if filters.venue:
            params["venue"] = filters.venue
        if filters.paper_type:
            params["publicationTypes"] = filters.paper_type
        return params

    @staticmethod
    def _author_filter(papers: list[PaperMetadata], filters: SearchFilters) -> list[PaperMetadata]:
        # No upstream author-name filter exists. This filters the fetched rows
        # only; it is deliberately not an expensive author search/join.
        if not filters.author:
            return papers
        author = normalize_text(filters.author)
        return [p for p in papers if any(author in normalize_text(a.name) for a in p.authors)]

    async def search(
        self, query: str, filters: SearchFilters, page: int = 1, size: int = 20
    ) -> SearchResult:
        offset = (page - 1) * size
        if page < 1 or not 1 <= size <= 100:
            raise ProviderError(
                "invalid_query",
                "Search supports page sizes 1–100.",
                status.HTTP_422_UNPROCESSABLE_CONTENT,
            )
        if offset >= SEARCH_WINDOW - 1:
            raise ProviderError(
                "search_window_exceeded",
                "Semantic Scholar ranks only the first 1,000 results; refine the search.",
                status.HTTP_422_UNPROCESSABLE_CONTENT,
            )
        params = {
            "query": query.replace("-", " "),
            "fields": PAPER_FIELDS,
            "offset": offset,
            "limit": min(size, SEARCH_WINDOW - 1 - offset),
            **self._filter_params(filters),
        }
        data = await self._get("/paper/search", params, exhausted_ok=offset > 0)
        if data is not None and "data" not in data and data.get("total") == 0:
            # A query with no matches is answered ``{"total": 0, "offset": 0}``.
            data = {**data, "data": []}
        rows, next_offset = self._page(data if data is not None else {"data": []})
        papers = self._author_filter(deduplicate(_map_rows(rows)), filters)
        total = _count((data or {}).get("total"))
        end = offset + len(rows)
        has_more = next_offset is not None and offset < next_offset < SEARCH_WINDOW - 1
        return SearchResult(
            papers=papers,
            total_count=total or 0,
            page=page,
            page_size=size,
            provider=self.name,
            has_more=has_more,
            total_estimate=total,
            window_capped=not has_more
            and (next_offset is not None or (end >= SEARCH_WINDOW - 1 and (total or 0) > end)),
        )

    async def search_bulk(
        self, query: str, filters: SearchFilters, sort: str, token: str | None = None
    ) -> BulkSearchPage:
        """One batch (up to 1,000 rows) of ``/paper/search/bulk`` in ``sort``
        order; ``token`` continues an earlier batch. Bulk search matches every
        word (stemmed) and does not rank by relevance. Date sorts end today:
        Semantic Scholar lists future-dated records first."""
        if sort not in BULK_SORTS:
            raise ProviderError(
                "invalid_query", "Unsupported sort order.", status.HTTP_422_UNPROCESSABLE_CONTENT
            )
        words = sanitize_bulk_query(query)
        if not words:
            raise ProviderError(
                "invalid_query",
                "Enter at least one search word.",
                status.HTTP_422_UNPROCESSABLE_CONTENT,
            )
        params = {"query": words, "fields": PAPER_FIELDS, "sort": sort}
        params.update(self._filter_params(filters))
        if sort == "publicationDate:desc":
            # The year filter becomes a date range that stops at today.
            params.pop("year", None)
            start = f"{filters.year_from:04d}-01-01" if filters.year_from else ""
            end = datetime.now(UTC).date().isoformat()
            if filters.year_to:
                end = min(end, f"{filters.year_to:04d}-12-31")
            if start > end:
                # Only future years were asked for: nothing is published yet.
                return BulkSearchPage(items=[], total=0)
            params["publicationDateOrYear"] = f"{start}:{end}"
        if token:
            params["token"] = token
        data = await self._get("/paper/search/bulk", params)
        rows, next_token = data.get("data"), data.get("token")
        if not isinstance(rows, list) or (
            next_token is not None and not isinstance(next_token, str)
        ):
            raise _bad_response("Semantic Scholar returned invalid pagination.")
        papers = self._author_filter(deduplicate(_map_rows(rows)), filters)
        return BulkSearchPage(
            items=papers, total=_count(data.get("total")) or 0, token=next_token or None
        )

    async def _related_rows(
        self,
        paper_id: str,
        direction: Literal["citations", "references"],
        offset: int,
        limit: int,
        fields: str,
    ) -> tuple[list[dict], int | None, bool]:
        """One page of citing (``citations``) or cited (``references``) papers
        that have a ``paperId``, the next offset (``None`` at the end) and
        whether the 10,000-record paging limit ended the list."""
        limit = min(limit, GRAPH_PAGE_SIZE, MAX_GRAPH_RECORDS - 1 - offset)
        if limit < 1:
            return [], None, True
        data = await self._get(
            f"{_paper_path(paper_id)}/{direction}",
            {"fields": fields, "offset": offset, "limit": limit},
            missing_ok=True,
        )
        if data is None:
            return [], None, False
        rows, next_offset = self._page(data)
        nested = "citedPaper" if direction == "references" else "citingPaper"
        papers = []
        for row in rows:
            if not isinstance(row, dict) or nested not in row:
                raise _bad_response("Semantic Scholar returned invalid citation data.")
            # Unresolved graph nodes have null paperId. They cannot form an edge.
            paper = row[nested]
            if isinstance(paper, dict) and _text(paper.get("paperId")):
                papers.append(paper)
        if next_offset is None:
            return papers, None, False
        if not rows or next_offset <= offset:
            raise _bad_response("Semantic Scholar returned non-advancing pagination.")
        if next_offset >= MAX_GRAPH_RECORDS - 1:
            return papers, None, True
        return papers, next_offset, False

    async def related_page(
        self,
        paper_id: str,
        direction: Literal["citations", "references"],
        offset: int = 0,
        limit: int = GRAPH_PAGE_SIZE,
        fields: str = RELATED_FIELDS,
    ) -> RelatedPage:
        """One offset page of the papers citing ``paper_id`` (``citations``)
        or cited by it (``references``) as ``related_entry`` rows, unordered.
        ``fields`` must cover the key inputs of ``related_entry``. At most
        9,999 records are reachable (``capped``); an unknown paper is an empty,
        finished list."""
        papers, next_offset, capped = await self._related_rows(
            paper_id, direction, offset, limit, fields
        )
        return RelatedPage(
            entries=[related_entry(paper) for paper in papers],
            next=next_offset,
            exhausted=next_offset is None,
            capped=capped,
        )

    async def _related_all(
        self, paper_id: str, direction: Literal["citations", "references"], fields: str
    ) -> list[dict]:
        papers: list[dict] = []
        offset: int | None = 0
        while offset is not None:
            rows, offset, _capped = await self._related_rows(
                paper_id, direction, offset, GRAPH_PAGE_SIZE, fields
            )
            papers.extend(rows)
        return papers

    async def reference_ids(self, paper_id: str) -> list[str]:
        """Sorted paperIds of every resolvable reference (up to 9,999)."""
        rows = await self._related_all(paper_id, "references", "paperId")
        return sorted({row["paperId"].strip().lower() for row in rows})

    async def _references(
        self, paper_id: str, direction: Literal["citations", "references"], relation: str
    ) -> list[PaperReference]:
        found: dict[str, PaperReference] = {}
        for row in await self._related_all(paper_id, direction, "paperId,title,externalIds"):
            doi = _doi(row)
            key = _canonical_key(row["paperId"].strip().lower(), doi)
            title = clean_inline_text(_text(row.get("title"))) or None
            found.setdefault(key, PaperReference(key, title, doi, relation))
        return list(found.values())

    async def get_references(self, paper_id: str) -> list[PaperReference]:
        return await self._references(paper_id, "references", "references")

    async def get_citations(self, paper_id: str) -> list[PaperReference]:
        return await self._references(paper_id, "citations", "cited_by")

    async def get_author(self, author_id: str) -> AuthorMetadata | None:
        # No application caller needs an author profile. Names/IDs arrive with papers.
        raise NotImplementedError("Author profiles are not used by the application")
