"""Explicit provider enablement, lazy construction and application operations.

The catalog retains inactive adapters without importing or constructing them.
Adding a catalog entry does not enable it: enablement and graph authority are
separate decisions. Request parameters can only narrow the enabled set.
"""

from importlib import import_module

from app.providers.base import BaseProvider, PaperMetadata, SearchFilters, SearchResult
from app.providers.semantic_scholar import ProviderError

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
    for provider in _instances.values():
        await provider.close()
    _instances.clear()


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
