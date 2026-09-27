"""Canonical and grouping key generation for papers."""

import hashlib
import re

from app.common.identifiers import strip_doi_prefixes


def _normalize_title(title: str | None) -> str:
    if not title:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", title.lower())).strip()


def _normalize_author_surnames(authors: list[str] | None) -> list[str]:
    surnames: list[str] = []
    for author in authors or []:
        parts = re.sub(r"\s+", " ", author.strip().lower()).split(" ")
        if parts and parts[-1]:
            surnames.append(parts[-1])
    return sorted(surnames)


def build_paper_group_key(title: str | None, authors: list[str] | None) -> str:
    parts = [_normalize_title(title), ",".join(_normalize_author_surnames(authors))]
    combined = "|".join(parts)
    hash_val = hashlib.sha256(combined.encode()).hexdigest()[:16]
    return f"group:{hash_val}"


def build_canonical_key(
    doi: str | None = None,
    title: str | None = None,
    authors: list[str] | None = None,
    year: int | None = None,
) -> str:
    if doi:
        # Never percent-decodes or validates: provider DOIs keep the exact
        # keys they always had; only prefixed input (doi:, dx.doi.org) changes.
        normalized = strip_doi_prefixes(doi, decode=False).lower()
        return f"doi:{normalized}"

    parts: list[str] = [build_paper_group_key(title, authors)]
    if year:
        parts.append(str(year))

    combined = "|".join(parts)
    hash_val = hashlib.sha256(combined.encode()).hexdigest()[:16]
    return f"hash:{hash_val}"
