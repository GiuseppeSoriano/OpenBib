"""Conservative "possible other version" hints for search results.

Records sharing a strong identifier are already merged by
``identity.deduplicate``; this only flags distinct records that look like
versions of one work (a preprint and its journal article, say). A pair is
flagged when both titles reduce to the same fingerprint of at least
``MIN_TITLE_WORDS`` words, the years are at most ``MAX_YEAR_GAP`` apart (or
one is unknown) and the first authors share a surname or the author surnames
overlap by a Jaccard index of at least ``MIN_AUTHOR_JACCARD``. Pairs that
share a Semantic Scholar id or a DOI are the same record and never flagged.
Nothing is ever merged.
"""

from app.common.text import clean_inline_text
from app.providers.base import Author, PaperMetadata
from app.providers.identity import aliases, normalize_text

# Shorter titles ("Deep learning", "Introduction") collide across unrelated works.
MIN_TITLE_WORDS = 4
MAX_YEAR_GAP = 1
MIN_AUTHOR_JACCARD = 0.5
_SAME_RECORD_ALIASES = ("s2:", "doi:")


def title_fingerprint(title: str | None) -> str | None:
    """Case-, punctuation- and markup-insensitive title, or ``None`` when the
    title is too short to tell works apart."""
    fingerprint = normalize_text(clean_inline_text(title)) if title else ""
    return fingerprint if len(fingerprint.split()) >= MIN_TITLE_WORDS else None


def surname(author: Author) -> str:
    """Normalized family name: the explicit one, the part before a comma
    ("Wu, Zonghan"), else the last word that is not an initial ("Wu Z",
    "Zonghan Wu" and "Z. Wu" all give "wu")."""
    if author.family_name:
        return normalize_text(author.family_name)
    name = author.name.split(",", 1)[0] if "," in author.name else author.name
    words = normalize_text(name).split()
    names = [word for word in words if len(word) > 1]
    return (names or words or [""])[-1]


def author_tokens(paper: PaperMetadata) -> set[str]:
    return {name for author in paper.authors if (name := surname(author))}


def _same_record(left: PaperMetadata, right: PaperMetadata) -> bool:
    def strong(paper: PaperMetadata) -> set[str]:
        return {alias for alias in aliases(paper) if alias.startswith(_SAME_RECORD_ALIASES)}

    return bool(strong(left) & strong(right))


def _years_compatible(left: PaperMetadata, right: PaperMetadata) -> bool:
    if left.publication_date is None or right.publication_date is None:
        return True
    return abs(left.publication_date.year - right.publication_date.year) <= MAX_YEAR_GAP


def _authors_compatible(left: PaperMetadata, right: PaperMetadata) -> bool:
    if not left.authors or not right.authors:
        return False
    first = surname(left.authors[0])
    if first and first == surname(right.authors[0]):
        return True
    left_names, right_names = author_tokens(left), author_tokens(right)
    union = left_names | right_names
    return bool(union) and len(left_names & right_names) / len(union) >= MIN_AUTHOR_JACCARD


def is_possible_version(left: PaperMetadata, right: PaperMetadata) -> bool:
    fingerprint = title_fingerprint(left.title)
    return (
        fingerprint is not None
        and fingerprint == title_fingerprint(right.title)
        and not _same_record(left, right)
        and _years_compatible(left, right)
        and _authors_compatible(left, right)
    )


def find_possible_versions(papers: list[PaperMetadata]) -> dict[str, list[str]]:
    """Per ``paper_group_key``, the other groups among ``papers`` holding a
    possible version of one of its records, in first-appearance order.
    Records of one group are already shown as versions and never flagged."""
    buckets: dict[str, list[PaperMetadata]] = {}
    for paper in papers:
        if fingerprint := title_fingerprint(paper.title):
            buckets.setdefault(fingerprint, []).append(paper)
    order = {
        key: index for index, key in enumerate(dict.fromkeys(p.paper_group_key for p in papers))
    }
    related: dict[str, set[str]] = {}
    for bucket in buckets.values():
        for i, left in enumerate(bucket):
            for right in bucket[i + 1 :]:
                if left.paper_group_key == right.paper_group_key:
                    continue
                if is_possible_version(left, right):
                    related.setdefault(left.paper_group_key, set()).add(right.paper_group_key)
                    related.setdefault(right.paper_group_key, set()).add(left.paper_group_key)
    return {group: sorted(others, key=order.__getitem__) for group, others in related.items()}
