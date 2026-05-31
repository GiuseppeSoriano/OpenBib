"""Canonical and grouping key generation for papers."""

import hashlib
import re


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
        normalized = doi.strip().lower()
        normalized = normalized.removeprefix("https://doi.org/")
        normalized = normalized.removeprefix("http://doi.org/")
        return f"doi:{normalized}"

    parts: list[str] = [build_paper_group_key(title, authors)]
    if year:
        parts.append(str(year))

    combined = "|".join(parts)
    hash_val = hashlib.sha256(combined.encode()).hexdigest()[:16]
    return f"hash:{hash_val}"
