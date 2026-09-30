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
from app.providers.base import (
    BaseProvider,
    BulkSearchPage,
    PaperMetadata,
    RelatedPage,
    SearchFilters,
    SearchResult,
)
from app.providers.semantic_scholar import DEFAULT_RETRY_AFTER, RELATED_FIELDS, ProviderError

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
# Search responses carry their own version on top of the namespace, so a
# response-shape change does not cool the graph and reference-id caches.
SEARCH_CACHE_VERSION = "v4"
# Graph growth direction → the provider's related list.
_RELATED_LISTS = {"cited_by": "citations", "cites": "references"}
# API sort → bulk-search sort.
_SORTED_SEARCH = {"citations": "citationCount:desc", "date": "publicationDate:desc"}
_instances: dict[str, BaseProvider] = {}


def selected_provider_names(names: list[str] | None = None) -> list[str]:
    requested = list(dict.fromkeys(names if names is not None else ENABLED_PROVIDERS))
    if not requested or any(name not in ENABLED_PROVIDERS for name in requested):
        raise ProviderError("invalid_query", "Requested paper provider is not enabled.", 422)
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
    """Outcome of resolving a DOI (or another strong identifier).
    ``not_found`` is definitive (the provider answered with a miss and, for a
    DOI, doi.org does not know the handle); any failure, timeout or
    registered-but-undescribed DOI is ``unavailable``, carrying the
    provider's ``Retry-After`` seconds when it gave one (the default after a
    timeout)."""

    status: Literal["found", "not_found", "unavailable"]
    paper: PaperMetadata | None = None
    retry_after: int | None = None
    # The provider's error code for an ``unavailable`` lookup, when it gave
    # one (e.g. ``provider_not_configured``), so callers can report it.
    code: str | None = None


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


async def _confirm_miss(doi: str) -> DoiLookup:
    # DataCite-only DOIs (Zenodo, figshare, arXiv) can be missing upstream: a
    # registered handle means "save as pending", never "does not exist". Only
    # a definitive "not registered" from doi.org rejects; a failed check is
    # an unconfirmed miss and stays pending too.
    exists = await doi_handle_exists(doi)
    return DoiLookup("not_found") if exists is False else DoiLookup("unavailable")


async def _resolve_doi_chain(doi: str, *, confirm_missing: bool) -> DoiLookup:
    # Read the module attribute on every call so tests can swap the chain.
    chain = LOOKUP_DOI_CHAIN if LOOKUP_DOI_CHAIN is not None else [get_provider()]
    if not chain:
        return DoiLookup("unavailable")
    failed = False
    retry_after: int | None = None
    code: str | None = None
    for provider in chain:
        try:
            result = await provider.lookup_by_doi(doi)
        except ProviderError as exc:
            if exc.code == "invalid_query":
                # The provider cannot read this DOI at all: a miss, not an outage.
                continue
            failed = True
            retry_after = exc.retry_after if retry_after is None else retry_after
            code = exc.code if code is None else code
            logger.warning("Provider %s failed DOI lookup: %s", provider.name, exc.code)
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
        return DoiLookup("unavailable", retry_after=retry_after, code=code)
    return await _confirm_miss(doi) if confirm_missing else DoiLookup("not_found")


async def resolve_doi(doi: str, *, confirm_missing: bool = True) -> DoiLookup:
    try:
        return await asyncio.wait_for(
            _resolve_doi_chain(doi, confirm_missing=confirm_missing),
            timeout=settings.doi_resolve_timeout_seconds,
        )
    except TimeoutError:
        # A slow or queued provider call is an outage the client can retry.
        logger.warning("DOI resolution timed out for %s", doi)
        return DoiLookup("unavailable", retry_after=DEFAULT_RETRY_AFTER)


async def _resolve_many(
    dois: list[str], results: dict[str, DoiLookup], *, confirm_missing: bool
) -> None:
    semaphore = asyncio.Semaphore(max(1, settings.import_resolve_concurrency))

    async def one(doi: str) -> None:
        async with semaphore:
            results[doi] = await _resolve_doi_chain(doi, confirm_missing=confirm_missing)

    async def confirm(doi: str) -> None:
        async with semaphore:
            results[doi] = await _confirm_miss(doi)

    if LOOKUP_DOI_CHAIN is not None:
        await asyncio.gather(*(one(doi) for doi in dois))
        return
    try:
        papers = await get_provider().lookup_many(["DOI:" + doi for doi in dois])
    except ProviderError as exc:
        logger.warning("Batch DOI lookup failed: %s", exc.code)
        if exc.code == "invalid_query":
            # One unreadable DOI rejects the whole batch: isolate it.
            await asyncio.gather(*(one(doi) for doi in dois))
            return
        for doi in dois:
            results[doi] = DoiLookup("unavailable", retry_after=exc.retry_after, code=exc.code)
        return
    except Exception:
        logger.warning("Batch DOI lookup failed", exc_info=True)
        return
    misses = []
    for doi, paper in zip(dois, papers, strict=True):
        if paper is not None:
            results[doi] = DoiLookup("found", paper)
        elif confirm_missing:
            misses.append(doi)
        else:
            results[doi] = DoiLookup("not_found")
    await asyncio.gather(*(confirm(doi) for doi in misses))


async def resolve_dois(
    dois: list[str], *, confirm_missing: bool = True, timeout: float | None = None
) -> dict[str, DoiLookup]:
    """Resolve many DOIs: batch lookups (500 per provider call), then doi.org
    handle checks for the misses only, ``import_resolve_concurrency`` at a
    time. Whatever is unfinished when ``timeout`` (default: the import request
    budget) runs out stays ``unavailable``."""
    wanted = list(dict.fromkeys(dois))
    results = {doi: DoiLookup("unavailable") for doi in wanted}
    if not wanted:
        return results
    budget = settings.import_request_budget_seconds if timeout is None else timeout
    try:
        await asyncio.wait_for(
            _resolve_many(wanted, results, confirm_missing=confirm_missing), timeout=budget
        )
    except TimeoutError:
        logger.warning("DOI resolution ran out of time for a batch of %d", len(wanted))
    return results


async def resolve_id(identifier: str) -> DoiLookup:
    """Resolve a strong key (``s2:``, ``arxiv:``, ``pmid:``, ``pmcid:``;
    ``doi:`` goes through ``resolve_doi``). Only DOIs can be confirmed
    elsewhere, so a provider miss here is a definitive ``not_found``."""
    prefix, _, value = identifier.partition(":")
    if prefix.lower() == "doi":
        return await resolve_doi(value)
    try:
        paper = await asyncio.wait_for(
            get_provider().lookup_by_id(identifier), timeout=settings.doi_resolve_timeout_seconds
        )
    except TimeoutError:
        logger.warning("Identifier resolution timed out for %s", identifier)
        return DoiLookup("unavailable", retry_after=DEFAULT_RETRY_AFTER)
    except ProviderError as exc:
        if exc.code == "invalid_query":
            return DoiLookup("not_found")
        logger.warning("Identifier lookup failed: %s", exc.code)
        return DoiLookup("unavailable", retry_after=exc.retry_after, code=exc.code)
    except Exception:
        logger.warning("Identifier lookup failed for %s", identifier, exc_info=True)
        return DoiLookup("unavailable")
    return DoiLookup("found", paper) if paper is not None else DoiLookup("not_found")


async def lookup_by_doi(doi: str) -> PaperMetadata | None:
    return await get_provider().lookup_by_doi(doi)


async def lookup_by_id(identifier: str) -> PaperMetadata | None:
    return await get_provider().lookup_by_id(identifier)


async def lookup_by_arxiv_id(arxiv_id: str) -> PaperMetadata | None:
    return await lookup_by_id("ARXIV:" + arxiv_id)


async def lookup_by_pmid(pmid: str) -> PaperMetadata | None:
    return await lookup_by_id("PMID:" + pmid)


async def papers_by_ids(ids: list[str]) -> list[PaperMetadata | None]:
    """Full records in input order (``None`` for a miss) from batch lookups
    of S2 paperIds or ``DOI:``/``ARXIV:``/``PMID:``/``PMCID:`` ids."""
    return await get_provider().lookup_many(ids) if ids else []


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


async def search_sorted(
    query: str,
    filters: SearchFilters | None = None,
    sort: Literal["date", "citations"] = "citations",
    token: str | None = None,
) -> BulkSearchPage:
    """One bulk batch (up to 1,000 rows) of every match, newest or most cited
    first; pass the returned ``token`` for the next batch."""
    return await get_provider().search_bulk(
        query, filters or SearchFilters(), _SORTED_SEARCH[sort], token
    )


async def related_page(
    paper_id: str,
    direction: Literal["cited_by", "cites"],
    offset: int = 0,
    limit: int | None = None,
    fields: str = RELATED_FIELDS,
) -> RelatedPage:
    """One unordered offset page of the papers citing ``paper_id``
    (``cited_by``) or cited by it (``cites``), ``graph_related_chunk_size``
    entries by default."""
    return await get_provider().related_page(
        paper_id,
        _RELATED_LISTS[direction],
        offset,
        limit or settings.graph_related_chunk_size,
        fields,
    )


async def references_batch(paper_ids: list[str]) -> dict[str, list[str]]:
    """Reference paperIds per paper id from batch calls; papers the provider
    does not know are left out."""
    wanted = list(dict.fromkeys(pid for pid in paper_ids if pid))
    if not wanted:
        return {}
    found = await get_provider().references_batch(wanted)
    return {pid: ids for pid, ids in zip(wanted, found, strict=True) if ids is not None}


async def get_references(paper_id: str):
    return await get_provider().get_references(paper_id)


async def get_citations(paper_id: str):
    return await get_provider().get_citations(paper_id)


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
