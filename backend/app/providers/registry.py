"""Explicit provider enablement, lazy construction and application operations.

The catalog retains inactive adapters without importing or constructing them.
Adding a catalog entry does not enable it: enablement and graph authority are
separate decisions. Request parameters can only narrow the enabled set.
"""

import asyncio
import logging
from dataclasses import dataclass
from importlib import import_module
from typing import Literal
from urllib.parse import quote

import httpx

from app.config import settings
from app.providers.base import BaseProvider, PaperMetadata, SearchFilters, SearchResult
from app.providers.semantic_scholar import ProviderError

logger = logging.getLogger(__name__)

PROVIDER_FACTORIES = {
    "semantic_scholar": ("app.providers.semantic_scholar", "SemanticScholarProvider"),
    "openalex": ("app.providers.openalex", "OpenAlexProvider"),
    "crossref": ("app.providers.crossref", "CrossrefProvider"),
    "arxiv": ("app.providers.arxiv", "ArxivProvider"),
    "europepmc": ("app.providers.europepmc", "EuropePMCProvider"),
}
ENABLED_PROVIDERS = ("semantic_scholar",)
PRIMARY_PROVIDER = ENABLED_PROVIDERS[0]
# Version all derived caches to avoid serving pre-refactor fanout/graph results.
CACHE_NAMESPACE = "papers-v3:" + "+".join(ENABLED_PROVIDERS)
_instances: dict[str, BaseProvider] = {}


def selected_provider_names(names: list[str] | None = None) -> list[str]:
    requested = list(dict.fromkeys(names if names is not None else ENABLED_PROVIDERS))
    if not requested or any(name not in ENABLED_PROVIDERS for name in requested):
        raise ProviderError("Requested paper provider is not enabled.", 422)
    return requested


def get_provider(name: str = PRIMARY_PROVIDER) -> BaseProvider:
    selected_provider_names([name])
    if name not in _instances:
        module, factory = PROVIDER_FACTORIES[name]
        _instances[name] = getattr(import_module(module), factory)()
    return _instances[name]


async def close_providers() -> None:
    global _handle_client
    for provider in _instances.values():
        await provider.close()
    _instances.clear()
    if _handle_client is not None:
        await _handle_client.aclose()
        _handle_client = None


@dataclass
class DoiLookup:
    """Outcome of resolving a DOI. ``not_found`` is definitive (the provider
    answered with a miss and doi.org does not know the handle); any failure,
    timeout or registered-but-undescribed DOI is ``unavailable``, carrying the
    provider's ``Retry-After`` seconds when it sent one."""

    status: Literal["found", "not_found", "unavailable"]
    paper: PaperMetadata | None = None
    retry_after: int | None = None


# Test override for the DOI resolution chain; ``None`` means the primary provider.
LOOKUP_DOI_CHAIN: list[BaseProvider] | None = None
_handle_client: httpx.AsyncClient | None = None


def _handle() -> httpx.AsyncClient:
    global _handle_client
    if _handle_client is None:
        _handle_client = httpx.AsyncClient(base_url="https://doi.org", timeout=5)
    return _handle_client


async def doi_handle_exists(doi: str) -> bool | None:
    """Ask the doi.org handle API whether the DOI is registered at all. It
    never fetches metadata. ``None`` means the check itself failed."""
    try:
        resp = await _handle().get(f"/api/handles/{quote(doi, safe='/')}", params={"type": "URL"})
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


def _retry_after(exc: ProviderError) -> int | None:
    value = (exc.headers or {}).get("Retry-After")
    try:
        return max(0, int(value)) if value is not None else None
    except ValueError:
        return None


async def _resolve_doi_chain(doi: str, *, confirm_missing: bool) -> DoiLookup:
    # Read the module attribute on every call so tests can swap the chain.
    chain = LOOKUP_DOI_CHAIN if LOOKUP_DOI_CHAIN is not None else [get_provider()]
    if not chain:
        return DoiLookup("unavailable")
    failed = False
    retry_after: int | None = None
    for provider in chain:
        try:
            result = await provider.lookup_by_doi(doi)
        except ProviderError as exc:
            failed = True
            retry_after = _retry_after(exc) if retry_after is None else retry_after
            logger.warning("Provider %s failed DOI lookup: %s", provider.name, exc.detail)
            continue
        except Exception:
            failed = True
            logger.warning(
                "Provider %s failed DOI lookup for %s", provider.name, doi, exc_info=True
            )
            continue
        if result:
            return DoiLookup("found", result)
    if failed:
        return DoiLookup("unavailable", retry_after=retry_after)
    if not confirm_missing:
        return DoiLookup("not_found")
    # DataCite-only DOIs (Zenodo, figshare, arXiv) can be missing upstream: a
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
    return await get_provider().lookup_by_doi(doi)


async def lookup_by_id(identifier: str) -> PaperMetadata | None:
    return await get_provider().lookup_by_id(identifier)


async def lookup_by_arxiv_id(arxiv_id: str) -> PaperMetadata | None:
    return await lookup_by_id("ARXIV:" + arxiv_id)


async def lookup_by_pmid(pmid: str) -> PaperMetadata | None:
    return await lookup_by_id("PMID:" + pmid)


async def search(
    query: str,
    filters: SearchFilters | None = None,
    page: int = 1,
    size: int = 20,
    provider_name: str = PRIMARY_PROVIDER,
) -> SearchResult:
    return await get_provider(provider_name).search(query, filters or SearchFilters(), page, size)


async def search_all(
    query: str,
    filters: SearchFilters | None = None,
    page: int = 1,
    size: int = 20,
    providers: list[str] | None = None,
) -> list[SearchResult]:
    return [
        await search(query, filters, page, size, name)
        for name in selected_provider_names(providers)
    ]


async def get_references(paper_id: str):
    return await get_provider().get_references(paper_id)


async def get_citations(paper_id: str):
    return await get_provider().get_citations(paper_id)


async def list_citing_papers(
    paper_id: str | None, *, order: str = "cited_by_count", limit: int = 25
) -> list[PaperMetadata]:
    if not paper_id:
        return []
    return await get_provider().list_related_papers(
        paper_id, direction="citations", order=order, limit=limit
    )


async def list_referenced_papers(
    paper_id: str | None, *, order: str = "cited_by_count", limit: int = 25
) -> list[PaperMetadata]:
    if not paper_id:
        return []
    return await get_provider().list_related_papers(
        paper_id, direction="references", order=order, limit=limit
    )


async def get_reference_ids(paper_id: str | None) -> list[str]:
    return await get_provider().reference_ids(paper_id) if paper_id else []


def paper_identifier(paper) -> str | None:
    """Resolve legacy snapshots through interoperable IDs, never an OpenAlex call."""
    if paper.semantic_scholar_id:
        return paper.semantic_scholar_id
    for field, prefix in (
        ("doi", "DOI"),
        ("arxiv_id", "ARXIV"),
        ("pmid", "PMID"),
        ("pmcid", "PMCID"),
    ):
        if value := getattr(paper, field, None):
            return f"{prefix}:{value}"
    if paper.canonical_key.startswith(("doi:", "s2:", "arxiv:", "pmid:", "pmcid:")):
        return paper.canonical_key
    return None
