"""Provider abstraction layer — base classes and data models."""

from __future__ import annotations

import re
import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date
from enum import Enum


class ProviderCapability(Enum):
    LOOKUP_DOI = "lookup_doi"
    LOOKUP_ID = "lookup_id"
    SEARCH = "search"
    REFERENCES = "references"
    CITATIONS = "citations"
    AUTHOR_PROFILE = "author_profile"
    VERSION_TRACKING = "version_tracking"
    FULL_TEXT_LINK = "full_text_link"


@dataclass
class Author:
    name: str
    family_name: str | None = None
    given_name: str | None = None
    openalex_id: str | None = None
    orcid: str | None = None
    affiliations: list[str] = field(default_factory=list)


@dataclass
class PaperMetadata:
    canonical_key: str
    title: str
    authors: list[Author] = field(default_factory=list)
    abstract: str | None = None
    publication_date: date | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    pmid: str | None = None
    pmcid: str | None = None
    openalex_id: str | None = None
    venue: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    paper_type: str | None = None
    topics: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    open_access: bool | None = None
    pdf_url: str | None = None
    abstract_url: str | None = None
    cited_by_count: int | None = None
    reference_count: int | None = None
    version: str | None = None
    provider_source: str = ""
    raw_response: dict | None = None


@dataclass
class PaperReference:
    canonical_key: str
    title: str | None = None
    doi: str | None = None
    relation_type: str = "references"


@dataclass
class SearchResult:
    papers: list[PaperMetadata]
    total_count: int
    page: int
    page_size: int
    provider: str


@dataclass
class SearchFilters:
    year_from: int | None = None
    year_to: int | None = None
    author: str | None = None
    venue: str | None = None
    open_access_only: bool = False
    paper_type: str | None = None


@dataclass
class AuthorMetadata:
    name: str
    openalex_id: str | None = None
    orcid: str | None = None
    affiliations: list[str] = field(default_factory=list)
    works_count: int | None = None
    cited_by_count: int | None = None


def build_canonical_key(
    doi: str | None,
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


class BaseProvider(ABC):
    """Abstract base for all external paper data providers."""

    name: str
    capabilities: set[ProviderCapability]

    @abstractmethod
    async def lookup_by_doi(self, doi: str) -> PaperMetadata | None: ...

    @abstractmethod
    async def lookup_by_id(self, provider_id: str) -> PaperMetadata | None: ...

    @abstractmethod
    async def search(
        self, query: str, filters: SearchFilters, page: int = 1, size: int = 20
    ) -> SearchResult: ...

    @abstractmethod
    async def get_references(self, paper_id: str) -> list[PaperReference]: ...

    @abstractmethod
    async def get_citations(self, paper_id: str) -> list[PaperReference]: ...

    @abstractmethod
    async def get_author(self, author_id: str) -> AuthorMetadata | None: ...
