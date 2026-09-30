"""Paper identifier parsing and normalization for user-supplied input.

Provider data keeps going through ``canonical.build_canonical_key``; these
helpers sit at the API boundary, where users paste bare DOIs, ``doi:`` keys,
DOI links or the occasional percent-encoded URL, and also Semantic Scholar
keys and links, arXiv IDs and links, PMIDs and PMCIDs.
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
# Semantic Scholar paperIds are 40 hex characters; links may carry a title slug.
_S2_RE = re.compile(r"^s2:([0-9a-f]{40})$", re.IGNORECASE)
_S2_URL_RE = re.compile(
    r"^(?:https?://)?(?:www\.)?semanticscholar\.org/paper/(?:[^/?#\s]+/)?([0-9a-f]{40})/?"
    r"(?:[?#]\S*)?$",
    re.IGNORECASE,
)
# New-style (2501.00663v2) and old-style (hep-th/9901001) arXiv IDs; only
# new-style IDs are recognized without an ``arxiv:`` prefix or a link.
_ARXIV_NEW = r"\d{4}\.\d{4,5}(?:v\d+)?"
_ARXIV_ID = rf"(?:{_ARXIV_NEW}|[a-z][a-z.-]*/\d{{7}}(?:v\d+)?)"
_ARXIV_RE = re.compile(
    rf"^(?:arxiv:\s*|(?:https?://)?(?:www\.|export\.)?arxiv\.org/(?:abs|pdf)/)"
    rf"({_ARXIV_ID})(?:\.pdf)?/?(?:[?#]\S*)?$",
    re.IGNORECASE,
)
_ARXIV_BARE_RE = re.compile(rf"^({_ARXIV_NEW})$")
_PMID_RE = re.compile(r"^pmid:\s*(\d{1,9})$", re.IGNORECASE)
_PMCID_RE = re.compile(r"^pmcid:\s*pmc(\d{1,9})$", re.IGNORECASE)
# Keys of the strong identifiers a provider can resolve (besides ``doi:``).
STRONG_PREFIXES = ("s2:", "arxiv:", "pmid:", "pmcid:")


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


def _strong_key(value: str) -> str | None:
    """``value`` with its ``s2:``/``arxiv:``/``pmid:``/``pmcid:`` prefix
    lowercased (and the S2 paperId too; a PMCID is stored as ``PMC<digits>``,
    so it is uppercased), or ``None`` for any other key."""
    prefix, sep, rest = value.partition(":")
    key_prefix = prefix.lower() + sep
    if not sep or key_prefix not in STRONG_PREFIXES:
        return None
    if key_prefix == "s2:":
        rest = rest.lower()
    elif key_prefix == "pmcid:":
        rest = rest.upper()
    return key_prefix + rest


def normalize_paper_key(raw: str) -> str:
    """Lenient key normalization for read, delete and annotation paths.

    ``hash:``/``group:`` keys pass through, and so do ``s2:``, ``arxiv:``,
    ``pmid:`` and ``pmcid:`` keys (prefix lowercased, and the S2 paperId
    too), DOI-like input becomes ``doi:<lowercase doi>``, and anything else
    is returned stripped so a lookup simply misses instead of failing.
    """
    value = _strip_edges(raw)
    if value.startswith(("hash:", "group:")):
        return value
    strong = _strong_key(value)
    if strong is not None:
        return strong
    doi = normalize_doi(value)
    return f"doi:{doi}" if doi else value


IdentifierKind = Literal["doi", "hash", "s2", "arxiv", "pmid", "pmcid"]


@dataclass(frozen=True)
class ParsedIdentifier:
    kind: IdentifierKind
    canonical_key: str
    doi: str | None
    raw: str

    @property
    def lookup_id(self) -> str | None:
        """What the provider resolves (``doi:`` through ``registry.resolve_doi``,
        the others through ``registry.resolve_id``); ``None`` for a ``hash:``
        key, which only the cache knows."""
        return None if self.kind == "hash" else self.canonical_key


def _strong_identifier(value: str) -> tuple[IdentifierKind, str] | None:
    if match := _S2_RE.fullmatch(value) or _S2_URL_RE.fullmatch(value):
        return "s2", f"s2:{match.group(1).lower()}"
    if match := _ARXIV_RE.fullmatch(value) or _ARXIV_BARE_RE.fullmatch(value):
        # Imported here: app.providers.identity imports this module.
        from app.providers.identity import normalize_arxiv

        return "arxiv", f"arxiv:{normalize_arxiv(match.group(1))}"
    if match := _PMID_RE.fullmatch(value):
        return "pmid", f"pmid:{match.group(1)}"
    if match := _PMCID_RE.fullmatch(value):
        return "pmcid", f"pmcid:PMC{match.group(1)}"
    return None


def parse_paper_identifier(raw: str) -> ParsedIdentifier:
    """Strict parsing for write paths: a DOI in any accepted form, a Semantic
    Scholar key or link, an arXiv ID or link, ``pmid:``/``pmcid:`` keys, or an
    existing ``hash:`` key (whose existence the caller checks)."""
    value = _strip_edges(raw)
    if _HASH_RE.fullmatch(value):
        return ParsedIdentifier(kind="hash", canonical_key=value, doi=None, raw=raw)
    strong = _strong_identifier(value)
    if strong is not None:
        return ParsedIdentifier(kind=strong[0], canonical_key=strong[1], doi=None, raw=raw)
    doi = normalize_doi(value)
    if doi is None:
        raise InvalidIdentifierError(raw)
    return ParsedIdentifier(kind="doi", canonical_key=f"doi:{doi}", doi=doi, raw=raw)


def parse_lookup_key(key: str) -> ParsedIdentifier | None:
    """The identifier behind a paper key when a provider can resolve it (a
    DOI or another strong identifier); ``None`` for ``hash:``/``group:`` keys
    and anything unparseable."""
    try:
        parsed = parse_paper_identifier(key)
    except InvalidIdentifierError:
        return None
    return parsed if parsed.lookup_id is not None else None


def synthetic_group_key(canonical_key: str) -> str:
    """Deterministic placeholder group for a paper with no cached metadata."""
    digest = hashlib.sha256(canonical_key.encode("utf-8")).hexdigest()[:16]
    return f"group:{digest}"


PaperKey = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=512),
    AfterValidator(normalize_paper_key),
]
