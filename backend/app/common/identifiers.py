"""Paper identifier parsing and normalization for user-supplied input.

Provider data keeps going through ``canonical.build_canonical_key``; these
helpers sit at the API boundary, where users paste bare DOIs, ``doi:`` keys,
DOI links or the occasional percent-encoded URL.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Annotated, Literal
from urllib.parse import unquote

from pydantic import AfterValidator, StringConstraints

from app.common.exceptions import InvalidIdentifierError

# Deliberately loose (registrant digits, a slash, any non-space suffix): real
# DOIs are messy and test fixtures use short forms such as ``10.1/x``.
DOI_RE = re.compile(r"^10\.\d+(?:\.\d+)*/\S+$")

# Whitespace (``\s`` includes NBSP) plus the zero-width characters that ride
# along with copy/paste.
_EDGE_RE = re.compile(r"^[\s\u200b\u200c\u200d\u2060\ufeff]+|[\s\u200b\u200c\u200d\u2060\ufeff]+$")
_PREFIX_RE = re.compile(
    r"^(?:https?://(?:dx\.|www\.)?doi\.org/|(?:dx\.|www\.)?doi\.org/|doi:\s*|doi\s+)",
    re.IGNORECASE,
)
_URL_FORM_RE = re.compile(r"://|doi\.org", re.IGNORECASE)
_HASH_RE = re.compile(r"^hash:\S{1,500}$")


def _strip_edges(value: str) -> str:
    return _EDGE_RE.sub("", value)


def strip_doi_prefixes(value: str, *, decode: bool = False) -> str:
    """Remove DOI resolver/label prefixes and surrounding whitespace.

    Percent-decoding happens only when ``decode`` is set and the input is a
    URL (``://`` or ``doi.org``), so a ``doi:`` key that legitimately contains
    ``%2F`` is never rewritten. Trailing punctuation is kept: some DOIs end in
    a period.
    """
    cleaned = _strip_edges(value)
    if decode and "%" in cleaned and _URL_FORM_RE.search(cleaned):
        cleaned = _strip_edges(unquote(cleaned))
    for _ in range(3):
        stripped = _PREFIX_RE.sub("", cleaned, count=1)
        if stripped == cleaned:
            break
        cleaned = _strip_edges(stripped)
    return cleaned


def normalize_doi(raw: str, *, decode: bool = True) -> str | None:
    """Bare lowercase DOI, or ``None`` when the input is not DOI-shaped."""
    doi = strip_doi_prefixes(raw, decode=decode).lower()
    return doi if DOI_RE.fullmatch(doi) else None


def normalize_paper_key(raw: str) -> str:
    """Lenient key normalization for read, delete and annotation paths.

    ``hash:``/``group:`` keys pass through, DOI-like input becomes
    ``doi:<lowercase doi>``, and anything else is returned stripped so a
    lookup simply misses instead of failing.
    """
    value = _strip_edges(raw)
    if value.startswith(("hash:", "group:")):
        return value
    doi = normalize_doi(value)
    return f"doi:{doi}" if doi else value


@dataclass(frozen=True)
class ParsedIdentifier:
    kind: Literal["doi", "hash"]
    canonical_key: str
    doi: str | None
    raw: str


def parse_paper_identifier(raw: str) -> ParsedIdentifier:
    """Strict parsing for write paths: a DOI in any accepted form, or an
    existing ``hash:`` key (whose existence the caller checks)."""
    value = _strip_edges(raw)
    if _HASH_RE.fullmatch(value):
        return ParsedIdentifier(kind="hash", canonical_key=value, doi=None, raw=raw)
    doi = normalize_doi(value)
    if doi is None:
        raise InvalidIdentifierError(raw)
    return ParsedIdentifier(kind="doi", canonical_key=f"doi:{doi}", doi=doi, raw=raw)


def synthetic_group_key(canonical_key: str) -> str:
    """Deterministic placeholder group for a paper with no cached metadata."""
    digest = hashlib.sha256(canonical_key.encode("utf-8")).hexdigest()[:16]
    return f"group:{digest}"


PaperKey = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=512),
    AfterValidator(normalize_paper_key),
]
