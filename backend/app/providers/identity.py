"""Provider-independent identity and lossless, deterministic metadata merging.

Strong aliases match S2 IDs, normalized DOIs, versionless arXiv IDs, PMID and
PMCID. Shared weaker IDs never override conflicting DOIs. Title fallback is
exact Unicode/case/punctuation normalization plus full author names and year,
only when BOTH records have no strong IDs; distinct versions stay distinct.
Ranking follows the first occurrence; metadata selection is order-independent.
"""

import json
import re
import unicodedata
from copy import deepcopy
from dataclasses import asdict, fields

from app.providers.base import PaperMetadata


def normalize_doi(value: str) -> str:
    return re.sub(
        r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value.strip(), flags=re.I
    ).lower()


def normalize_arxiv(value: str) -> str:
    value = re.sub(r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:)", "", value.strip(), flags=re.I)
    return re.sub(r"v\d+$", "", value.removesuffix(".pdf"), flags=re.I).lower()


def normalize_text(value: str) -> str:
    return " ".join(
        "".join(
            c if c.isalnum() else " " for c in unicodedata.normalize("NFKC", value).casefold()
        ).split()
    )


def aliases(paper: PaperMetadata) -> set[str]:
    result = set()
    for field, prefix, normalize in (
        ("semantic_scholar_id", "s2", str.lower),
        ("doi", "doi", normalize_doi),
        ("arxiv_id", "arxiv", normalize_arxiv),
        ("pmid", "pmid", str.strip),
        ("pmcid", "pmcid", str.upper),
        ("openalex_id", "openalex", str.lower),
    ):
        if value := getattr(paper, field):
            result.add(f"{prefix}:{normalize(value)}")
    if paper.canonical_key.startswith(("doi:", "s2:", "arxiv:", "pmid:", "pmcid:")):
        prefix, value = paper.canonical_key.split(":", 1)
        normalizer = {"doi": normalize_doi, "arxiv": normalize_arxiv}.get(prefix, str.lower)
        result.add(f"{prefix}:{normalizer(value)}")
    return result


def _title_alias(paper: PaperMetadata) -> str | None:
    if aliases(paper) or not paper.title or not paper.authors or not paper.publication_date:
        return None
    authors = sorted(normalize_text(a.name) for a in paper.authors)
    if not all(authors):
        return None
    return repr((normalize_text(paper.title), authors, paper.publication_date.year, paper.version))


def _compatible(left: PaperMetadata, right: PaperMetadata, shared_aliases: set[str]) -> bool:
    if any(key.startswith("s2:") for key in shared_aliases):
        return True
    left_ids, right_ids = aliases(left), aliases(right)
    if (left_ids or right_ids) and not shared_aliases:
        return False
    if not left_ids and not right_ids:
        # Legacy hashes used author surnames, so equal hashes alone can collide
        # for different authors. Reject known contradictions before filling gaps.
        if normalize_text(left.title) != normalize_text(right.title):
            return False
        if (
            left.authors
            and right.authors
            and (
                sorted(normalize_text(a.name) for a in left.authors)
                != sorted(normalize_text(a.name) for a in right.authors)
            )
        ):
            return False
        if (
            left.publication_date
            and right.publication_date
            and left.publication_date.year != right.publication_date.year
        ):
            return False
    if left.doi and right.doi and normalize_doi(left.doi) != normalize_doi(right.doi):
        return False
    return not (left.version and right.version and left.version != right.version)


def merge_metadata(left: PaperMetadata, right: PaperMetadata) -> PaperMetadata:
    """Merge fields independently so enrichment does not change later tie-breaks.

    Longer textual metadata wins, then lexical order. Stable IDs/group anchors
    use lexical minimum on conflicts; counts use maximum. This is commutative
    and associative for scalar fields, unlike choosing the fullest whole record
    (whose completeness changes after each merge).
    """
    result = deepcopy(left)
    special = {"authors", "topics", "keywords", "provider_sources", "raw_response"}
    identifiers = {
        "canonical_key",
        "paper_group_key",
        "semantic_scholar_id",
        "doi",
        "arxiv_id",
        "pmid",
        "pmcid",
        "openalex_id",
        "provider_source",
    }
    for f in fields(result):
        if f.name in special:
            continue
        values = [
            v for v in (getattr(left, f.name), getattr(right, f.name)) if v is not None and v != ""
        ]
        if not values:
            continue
        if f.name in identifiers:
            chosen = min(values)
        elif isinstance(values[0], str):
            chosen = max(values, key=lambda v: (len(v), v))
        else:
            chosen = max(values)
        setattr(result, f.name, chosen)
    result.raw_response = None
    result.provider_sources = sorted(
        set(
            left.provider_sources
            + right.provider_sources
            + [p.provider_source for p in (left, right) if p.provider_source]
        )
    )
    for name in ("topics", "keywords"):
        setattr(result, name, sorted(set(getattr(left, name) + getattr(right, name))))
    for name in ("cited_by_count", "reference_count"):
        values = [v for v in (getattr(left, name), getattr(right, name)) if v is not None]
        setattr(result, name, max(values) if values else None)
    # Preserve author order from the fuller author list, enriching matching names.
    primary, secondary = sorted(
        (left.authors, right.authors),
        key=lambda a: (len(a), json.dumps([asdict(x) for x in a], sort_keys=True)),
        reverse=True,
    )
    result.authors = deepcopy(primary)
    for author in secondary:
        match = next(
            (
                a
                for a in result.authors
                if (a.semantic_scholar_id and a.semantic_scholar_id == author.semantic_scholar_id)
                or (a.orcid and a.orcid == author.orcid)
                or (a.openalex_id and a.openalex_id == author.openalex_id)
                or (
                    normalize_text(a.name) == normalize_text(author.name)
                    and not (
                        a.semantic_scholar_id
                        and author.semantic_scholar_id
                        and a.semantic_scholar_id != author.semantic_scholar_id
                    )
                )
            ),
            None,
        )
        if match is None:
            result.authors.append(deepcopy(author))
        else:
            for f in fields(match):
                if f.name == "affiliations":
                    continue
                values = [v for v in (getattr(match, f.name), getattr(author, f.name)) if v]
                if values:
                    setattr(match, f.name, max(values, key=lambda v: (len(v), v)))
            match.affiliations = sorted(set(match.affiliations + author.affiliations))
    # Existing DOI keys remain compatible with library pins, collections and notes.
    if result.doi:
        result.doi = normalize_doi(result.doi)
        result.canonical_key = f"doi:{result.doi}"
    elif result.semantic_scholar_id:
        result.canonical_key = f"s2:{result.semantic_scholar_id.lower()}"
    return result


def deduplicate(papers: list[PaperMetadata]) -> list[PaperMetadata]:
    ordered: dict[int, PaperMetadata] = {}
    index: dict[str, set[int]] = {}
    slot_keys: dict[int, set[str]] = {}
    for pos, original in enumerate(papers):
        paper = deepcopy(original)
        keys = aliases(paper) | {"key:" + paper.canonical_key}
        if title := _title_alias(paper):
            keys.add("title:" + title)
        candidates = sorted(set().union(*(index.get(k, set()) for k in keys)))
        matched = []
        for candidate in candidates:
            existing = ordered[candidate]
            shared = {
                key for key in slot_keys[candidate] & keys if not key.startswith(("key:", "title:"))
            }
            if _compatible(existing, paper, shared):
                paper = merge_metadata(existing, paper)
                matched.append(candidate)
        slot = min(matched, default=pos)
        for candidate in matched:
            del ordered[candidate]
            old_keys = slot_keys.pop(candidate)
            keys.update(old_keys)
            for key in old_keys:
                index[key].discard(candidate)
        keys.update(aliases(paper))
        paper.provider_sources = sorted(
            set(paper.provider_sources + ([paper.provider_source] if paper.provider_source else []))
        )
        ordered[slot] = paper
        slot_keys[slot] = keys
        for key in keys:
            index.setdefault(key, set()).add(slot)
    return [ordered[i] for i in sorted(ordered)]
