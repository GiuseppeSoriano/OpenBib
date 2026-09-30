"""Provider abstraction layer — base classes and data models."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date
from enum import Enum

from app.common.canonical import build_canonical_key as build_canonical_key
from app.common.canonical import build_paper_group_key as build_paper_group_key


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
    semantic_scholar_id: str | None = None
    openalex_id: str | None = None
    orcid: str | None = None
    affiliations: list[str] = field(default_factory=list)


@dataclass
class PaperMetadata:
    canonical_key: str
    paper_group_key: str
    title: str
    authors: list[Author] = field(default_factory=list)
    abstract: str | None = None
    publication_date: date | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    pmid: str | None = None
    pmcid: str | None = None
    semantic_scholar_id: str | None = None
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
    provider_sources: list[str] = field(default_factory=list)
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
    providers: list[str] = field(default_factory=list)
    # Providers must report continuation before local filtering/deduplication.
    has_more: bool = False


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

    async def list_related_papers(
        self, paper_id: str, *, direction: str, order: str, limit: int
    ) -> list[PaperMetadata]:
        raise NotImplementedError

    async def reference_ids(self, paper_id: str) -> list[str]:
        raise NotImplementedError

    async def close(self) -> None:
        """Close an adapter client when initialized; inactive adapters are never constructed."""
        client = getattr(self, "_client", None)
        if client is not None:
            await client.aclose()

    @abstractmethod
    async def get_author(self, author_id: str) -> AuthorMetadata | None: ...
