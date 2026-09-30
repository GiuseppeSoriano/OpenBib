"""Search continuation for the single provider.

Relevance search pages by ``page`` inside Semantic Scholar's first 1,000
results. The date and citation sorts read ``/paper/search/bulk`` batches (up
to 1,000 rows each), cache every batch in Redis and serve ``size``-row
slices through an opaque cursor, so "Show more" never downloads a batch twice.
"""

import base64
import binascii
import hashlib
import json
import logging
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime

from fastapi import status

from app.common.exceptions import ApiError
from app.config import settings
from app.providers import registry
from app.providers.base import Author, BulkSearchPage, PaperMetadata, SearchFilters
from app.providers.semantic_scholar import SEARCH_WINDOW

logger = logging.getLogger(__name__)

MIN_YEAR = 1800
CURSOR_VERSION = 1
# The sorts served from bulk-search batches through a cursor.
SORTED_MODES = ("date", "citations")
# A bulk batch holds at most this many rows, so a slice index stays below it.
MAX_BATCH_ROWS = 1000
_MAX_TOKEN_LENGTH = 2048


def max_year() -> int:
    return datetime.now(UTC).year + 1


def validate_years(year_from: int | None, year_to: int | None) -> None:
    """422 ``invalid_year_range`` for a year outside 1800..next year or a
    range that ends before it starts."""
    bounds = {"min_year": MIN_YEAR, "max_year": max_year()}
    if any(
        year is not None and not MIN_YEAR <= year <= bounds["max_year"]
        for year in (year_from, year_to)
    ):
        raise ApiError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "invalid_year_range",
            f"Years must be between {MIN_YEAR} and {bounds['max_year']}.",
            **bounds,
        )
    if year_from is not None and year_to is not None and year_from > year_to:
        raise ApiError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "invalid_year_range",
            "The start year must not be after the end year.",
            **bounds,
        )


def check_relevance_window(page: int, size: int) -> None:
    """Relevance search serves only ``offset + limit < 1000``: a page starting
    at the window's end can never be answered."""
    if (page - 1) * size >= SEARCH_WINDOW - 1:
        raise ApiError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "search_window_exceeded",
            "Semantic Scholar ranks only the first 1,000 results; refine the search.",
        )


def filters_identity(query: str, filters: SearchFilters) -> dict:
    return {
        "q": query,
        "year_from": filters.year_from,
        "year_to": filters.year_to,
        "author": filters.author,
        "open_access_only": filters.open_access_only,
    }


def query_signature(query: str, filters: SearchFilters, sort: str) -> str:
    """Binds a cursor to its query, so it cannot continue another search."""
    identity = json.dumps({**filters_identity(query, filters), "sort": sort}, sort_keys=True)
    return hashlib.sha256(identity.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class Cursor:
    token: str | None
    index: int


def _invalid_cursor() -> ApiError:
    return ApiError(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "invalid_cursor",
        "This results page is no longer valid; start the search again.",
    )


def encode_cursor(sort: str, token: str | None, index: int, signature: str) -> str:
    raw = json.dumps(
        {"v": CURSOR_VERSION, "sort": sort, "token": token, "index": index, "sig": signature},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(value: str, *, sort: str, signature: str) -> Cursor:
    """The position a ``next_cursor`` names; 422 ``invalid_cursor`` when it
    is malformed, from another version, sort or query. Relevance search
    pages by ``page`` and takes no cursor."""
    if sort not in SORTED_MODES:
        raise _invalid_cursor()
    try:
        data = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
    except (ValueError, binascii.Error, UnicodeError):
        raise _invalid_cursor() from None
    if not isinstance(data, dict):
        raise _invalid_cursor()
    token, index = data.get("token"), data.get("index")
    if (
        data.get("v") != CURSOR_VERSION
        or data.get("sort") != sort
        or data.get("sig") != signature
        or not (token is None or (isinstance(token, str) and 0 < len(token) <= _MAX_TOKEN_LENGTH))
        or type(index) is not int
        or not 0 <= index < MAX_BATCH_ROWS
    ):
        raise _invalid_cursor()
    return Cursor(token=token, index=index)


def _batch_key(query: str, filters: SearchFilters, sort: str, token: str | None) -> str:
    identity = json.dumps(
        {
            "v": registry.SEARCH_CACHE_VERSION,
            **filters_identity(query, filters),
            "sort": sort,
            "token": token,
        },
        sort_keys=True,
    )
    digest = hashlib.sha256(identity.encode()).hexdigest()[:32]
    return f"openbib:cache:{registry.CACHE_NAMESPACE}:search-bulk:{digest}"


def _paper_to_dict(paper: PaperMetadata) -> dict:
    data = asdict(paper)
    data["raw_response"] = None
    return data


def _paper_from_dict(data: dict) -> PaperMetadata:
    data = dict(data)
    data["authors"] = [Author(**author) for author in data["authors"]]
    if data.get("publication_date"):
        data["publication_date"] = date.fromisoformat(data["publication_date"])
    return PaperMetadata(**data)


async def load_batch(
    redis, query: str, filters: SearchFilters, sort: str, token: str | None
) -> BulkSearchPage:
    """One bulk batch, from Redis when an earlier slice already fetched it.
    A failed provider call raises and caches nothing; Redis trouble only
    bypasses the cache."""
    key = _batch_key(query, filters, sort, token)
    try:
        raw = await redis.get(key)
    except Exception:
        raw = None
    if raw is not None:
        try:
            data = json.loads(raw)
            return BulkSearchPage(
                items=[_paper_from_dict(item) for item in data["items"]],
                total=data["total"],
                token=data["token"],
            )
        except (ValueError, TypeError, KeyError):
            logger.debug("Ignoring an unreadable bulk search batch")
    batch = await registry.search_sorted(query, filters, sort, token)
    payload = {
        "items": [_paper_to_dict(paper) for paper in batch.items],
        "total": batch.total,
        "token": batch.token,
    }
    try:
        await redis.set(key, json.dumps(payload, default=str), ex=settings.cache_ttl_search)
    except Exception:
        logger.debug("Bulk search batch cache write failed; continuing without cache")
    return batch


@dataclass
class SortedSlice:
    papers: list[PaperMetadata]
    total: int
    next_cursor: str | None


async def sorted_slice(
    redis,
    query: str,
    filters: SearchFilters,
    sort: str,
    cursor: Cursor | None,
    size: int,
) -> SortedSlice:
    """``size`` rows of a sorted search from the batch ``cursor`` names (the
    first batch without one), and the cursor of the rows after them."""
    token, index = (cursor.token, cursor.index) if cursor else (None, 0)
    batch = await load_batch(redis, query, filters, sort, token)
    end = index + size
    signature = query_signature(query, filters, sort)
    if end < len(batch.items):
        next_cursor = encode_cursor(sort, token, end, signature)
    elif batch.token:
        next_cursor = encode_cursor(sort, batch.token, 0, signature)
    else:
        next_cursor = None
    return SortedSlice(batch.items[index:end], batch.total, next_cursor)
