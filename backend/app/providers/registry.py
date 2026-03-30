"""Provider registry — fallback chain and multi-provider orchestration."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.providers.arxiv import ArxivProvider
from app.providers.base import (
    AuthorMetadata,
    PaperMetadata,
    PaperReference,
    ProviderCapability,
    SearchFilters,
    SearchResult,
)
from app.providers.crossref import CrossrefProvider
from app.providers.europepmc import EuropePMCProvider
from app.providers.openalex import OpenAlexProvider

if TYPE_CHECKING:
    from app.providers.base import BaseProvider

logger = logging.getLogger(__name__)

# Singleton instances
_openalex = OpenAlexProvider()
_crossref = CrossrefProvider()
_arxiv = ArxivProvider()
_europepmc = EuropePMCProvider()

# Fallback chains per operation
LOOKUP_DOI_CHAIN: list[BaseProvider] = [_openalex, _crossref, _europepmc]
LOOKUP_ARXIV_CHAIN: list[BaseProvider] = [_arxiv, _openalex]
LOOKUP_PMID_CHAIN: list[BaseProvider] = [_europepmc, _openalex]
REFERENCES_CHAIN: list[BaseProvider] = [_openalex, _crossref, _europepmc]
CITATIONS_CHAIN: list[BaseProvider] = [_openalex, _europepmc]

# All providers by name
_PROVIDERS: dict[str, BaseProvider] = {
    "openalex": _openalex,
    "crossref": _crossref,
    "arxiv": _arxiv,
    "europepmc": _europepmc,
}


def get_provider(name: str) -> BaseProvider | None:
    return _PROVIDERS.get(name)


async def lookup_by_doi(doi: str) -> PaperMetadata | None:
    for provider in LOOKUP_DOI_CHAIN:
        try:
            result = await provider.lookup_by_doi(doi)
            if result:
                return result
        except Exception:
            logger.warning("Provider %s failed DOI lookup for %s", provider.name, doi, exc_info=True)
    return None


async def lookup_by_arxiv_id(arxiv_id: str) -> PaperMetadata | None:
    for provider in LOOKUP_ARXIV_CHAIN:
        try:
            result = await provider.lookup_by_id(arxiv_id)
            if result:
                return result
        except Exception:
            logger.warning("Provider %s failed arXiv lookup for %s", provider.name, arxiv_id, exc_info=True)
    return None


async def lookup_by_pmid(pmid: str) -> PaperMetadata | None:
    for provider in LOOKUP_PMID_CHAIN:
        try:
            result = await provider.lookup_by_id(pmid)
            if result:
                return result
        except Exception:
            logger.warning("Provider %s failed PMID lookup for %s", provider.name, pmid, exc_info=True)
    return None


async def search(
    query: str,
    filters: SearchFilters | None = None,
    page: int = 1,
    size: int = 20,
    provider_name: str = "openalex",
) -> SearchResult:
    """Search using a specific provider (default: OpenAlex)."""
    provider = _PROVIDERS.get(provider_name, _openalex)
    if ProviderCapability.SEARCH not in provider.capabilities:
        provider = _openalex

    f = filters or SearchFilters()
    return await provider.search(query, f, page, size)


async def get_references(paper_id: str) -> list[PaperReference]:
    for provider in REFERENCES_CHAIN:
        if ProviderCapability.REFERENCES not in provider.capabilities:
            continue
        try:
            result = await provider.get_references(paper_id)
            if result:
                return result
        except Exception:
            logger.warning("Provider %s failed references for %s", provider.name, paper_id, exc_info=True)
    return []


async def get_citations(paper_id: str) -> list[PaperReference]:
    for provider in CITATIONS_CHAIN:
        if ProviderCapability.CITATIONS not in provider.capabilities:
            continue
        try:
            result = await provider.get_citations(paper_id)
            if result:
                return result
        except Exception:
            logger.warning("Provider %s failed citations for %s", provider.name, paper_id, exc_info=True)
    return []


async def get_author(author_id: str) -> AuthorMetadata | None:
    """Author profiles — only OpenAlex for MVP."""
    try:
        return await _openalex.get_author(author_id)
    except Exception:
        logger.warning("OpenAlex author lookup failed for %s", author_id, exc_info=True)
        return None
