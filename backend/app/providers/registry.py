"""Provider registry — fallback chain and multi-provider orchestration."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal
from urllib.parse import quote

import httpx

from app.config import settings
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


@dataclass
class DoiLookup:
    """Outcome of resolving a DOI. ``not_found`` is definitive (every provider
    answered with a miss and doi.org does not know the handle); any failure,
    timeout or registered-but-undescribed DOI is ``unavailable``."""

    status: Literal["found", "not_found", "unavailable"]
    paper: PaperMetadata | None = None


_handle_client = httpx.AsyncClient(base_url="https://doi.org", timeout=5)


async def doi_handle_exists(doi: str) -> bool | None:
    """Ask the doi.org handle API whether the DOI is registered at all.
    ``None`` means the check itself failed."""
    try:
        resp = await _handle_client.get(
            f"/api/handles/{quote(doi, safe='/')}", params={"type": "URL"}
        )
    except httpx.HTTPError:
        logger.warning("DOI handle check failed", exc_info=True)
        return None
    if resp.status_code == 404:
        return False
    if resp.status_code != 200:
        return None
    try:
        return resp.json().get("responseCode") == 1
    except ValueError:
        return None


async def _resolve_doi_chain(doi: str, *, confirm_missing: bool) -> DoiLookup:
    # Read the module attribute on every call so tests can swap the chain.
    chain = LOOKUP_DOI_CHAIN
    if not chain:
        return DoiLookup("unavailable")
    failed = False
    for provider in chain:
        try:
            result = await provider.lookup_by_doi(doi)
        except Exception:
            failed = True
            logger.warning(
                "Provider %s failed DOI lookup for %s", provider.name, doi, exc_info=True
            )
            continue
        if result:
            return DoiLookup("found", result)
    if failed:
        return DoiLookup("unavailable")
    if not confirm_missing:
        return DoiLookup("not_found")
    # DataCite-only DOIs (Zenodo, figshare, arXiv) can miss everywhere: a
    # registered handle means "save as pending", never "does not exist". Only
    # a definitive "not registered" from doi.org rejects; a failed check is
    # an unconfirmed miss and stays pending too.
    exists = await doi_handle_exists(doi)
    return DoiLookup("not_found") if exists is False else DoiLookup("unavailable")


async def resolve_doi(doi: str, *, confirm_missing: bool = True) -> DoiLookup:
    try:
        return await asyncio.wait_for(
            _resolve_doi_chain(doi, confirm_missing=confirm_missing),
            timeout=settings.doi_resolve_timeout_seconds,
        )
    except TimeoutError:
        logger.warning("DOI resolution timed out for %s", doi)
        return DoiLookup("unavailable")


async def lookup_by_doi(doi: str) -> PaperMetadata | None:
    return (await resolve_doi(doi, confirm_missing=False)).paper


async def lookup_by_arxiv_id(arxiv_id: str) -> PaperMetadata | None:
    for provider in LOOKUP_ARXIV_CHAIN:
        try:
            result = await provider.lookup_by_id(arxiv_id)
            if result:
                return result
        except Exception:
            logger.warning(
                "Provider %s failed arXiv lookup for %s", provider.name, arxiv_id, exc_info=True
            )
    return None


async def lookup_by_pmid(pmid: str) -> PaperMetadata | None:
    for provider in LOOKUP_PMID_CHAIN:
        try:
            result = await provider.lookup_by_id(pmid)
            if result:
                return result
        except Exception:
            logger.warning(
                "Provider %s failed PMID lookup for %s", provider.name, pmid, exc_info=True
            )
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


# Default order when fanning out across all providers — used as both the
# query order AND the round-robin tie-break for cross-provider duplicates.
SEARCH_FANOUT_ORDER: list[str] = ["openalex", "crossref", "arxiv", "europepmc"]


async def search_all(
    query: str,
    filters: SearchFilters | None = None,
    page: int = 1,
    size: int = 20,
    providers: list[str] | None = None,
) -> list[SearchResult]:
    """Fan out the search across multiple providers in parallel.

    Defaults to all four search-capable providers in SEARCH_FANOUT_ORDER.
    Failed providers (timeout, 5xx, parse error) are logged and dropped —
    a single bad provider must not fail the whole search. Returns the
    successful results in the requested provider order.
    """
    f = filters or SearchFilters()
    requested = providers or SEARCH_FANOUT_ORDER
    selected: list[BaseProvider] = []
    for name in requested:
        provider = _PROVIDERS.get(name)
        if provider is None:
            logger.warning("Unknown provider requested in search_all: %s", name)
            continue
        if ProviderCapability.SEARCH not in provider.capabilities:
            continue
        selected.append(provider)

    if not selected:
        return []

    raw_results = await asyncio.gather(
        *(p.search(query, f, page, size) for p in selected),
        return_exceptions=True,
    )

    results: list[SearchResult] = []
    for _provider, outcome in zip(selected, raw_results, strict=True):
        if isinstance(outcome, Exception):
            logger.warning(
                "Provider search failed",
            )
            continue
        results.append(outcome)
    return results


async def get_references(paper_id: str) -> list[PaperReference]:
    for provider in REFERENCES_CHAIN:
        if ProviderCapability.REFERENCES not in provider.capabilities:
            continue
        try:
            result = await provider.get_references(paper_id)
            if result:
                return result
        except Exception:
            logger.warning(
                "Provider %s failed references for %s", provider.name, paper_id, exc_info=True
            )
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
            logger.warning(
                "Provider %s failed citations for %s", provider.name, paper_id, exc_info=True
            )
    return []


# Map the UI-facing ordering choice to an OpenAlex sort expression.
_CITING_SORTS = {
    "cited_by_count": "cited_by_count:desc",
    "recent": "publication_date:desc",
}


async def list_citing_papers(
    openalex_id: str | None,
    *,
    order: str = "cited_by_count",
    limit: int = 25,
) -> list[PaperMetadata]:
    """Papers that cite the given work, as fully-mapped metadata.

    Targets OpenAlex (the citation authority with sortable results). Returns
    ``[]`` gracefully when no OpenAlex id is known — for example for papers
    that only exist as a ``hash:`` canonical key. ``order`` is one of
    ``cited_by_count`` (default) or ``recent``.

    NOTE: EuropePMC also exposes citations but keyed by PMID/PMCID (a different
    native id) with no sort support, so it is intentionally not chained here
    for v1; pmid-based fallback is future work.
    """
    if not openalex_id:
        return []
    sort = _CITING_SORTS.get(order, _CITING_SORTS["cited_by_count"])
    try:
        return await _openalex.list_citing_papers(openalex_id, sort=sort, per_page=limit)
    except Exception:
        logger.warning("OpenAlex failed citing-papers for %s", openalex_id, exc_info=True)
        return []


async def list_referenced_papers(
    openalex_id: str | None,
    *,
    order: str = "cited_by_count",
    limit: int = 25,
) -> list[PaperMetadata]:
    """Papers that the given work cites — its references — as fully-mapped
    metadata (mirror of ``list_citing_papers``). OpenAlex-only; returns ``[]``
    gracefully when no OpenAlex id is known."""
    if not openalex_id:
        return []
    sort = _CITING_SORTS.get(order, _CITING_SORTS["cited_by_count"])
    try:
        return await _openalex.list_referenced_papers(openalex_id, sort=sort, per_page=limit)
    except Exception:
        logger.warning("OpenAlex failed referenced-papers for %s", openalex_id, exc_info=True)
        return []


async def get_openalex_reference_ids(openalex_id: str | None) -> list[str]:
    """OpenAlex work ids (full URLs) referenced by the given work.

    Used to compute exact citation edges *among papers already in the app*:
    intersect these ids with the in-app paper set. OpenAlex-only on purpose —
    its ``referenced_works`` is a complete, single-call list whose id format
    matches our cached ``openalex_id`` values.
    """
    if not openalex_id:
        return []
    short = openalex_id.rsplit("/", 1)[-1]
    try:
        refs = await _openalex.get_references(short)
    except Exception:
        logger.warning("OpenAlex failed references for %s", openalex_id, exc_info=True)
        return []
    return [r.canonical_key for r in refs if r.canonical_key]


async def get_author(author_id: str) -> AuthorMetadata | None:
    """Author profiles — only OpenAlex for MVP."""
    try:
        return await _openalex.get_author(author_id)
    except Exception:
        logger.warning("OpenAlex author lookup failed for %s", author_id, exc_info=True)
        return None
