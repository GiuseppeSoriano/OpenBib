"""Canonical key generation for papers."""

import hashlib
import re


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

    parts: list[str] = []
    if title:
        normalized_title = re.sub(r"[^a-z0-9 ]", "", title.lower()).strip()
        parts.append(normalized_title)
    if authors:
        sorted_names = sorted(a.split()[-1].lower() for a in authors if a.strip())
        parts.append(",".join(sorted_names))
    if year:
        parts.append(str(year))

    combined = "|".join(parts)
    hash_val = hashlib.sha256(combined.encode()).hexdigest()[:16]
    return f"hash:{hash_val}"
