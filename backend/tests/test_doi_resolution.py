"""DOI resolution outcomes across the provider chain and the doi.org handle check."""

import asyncio
from datetime import date

import pytest
import respx
from httpx import Response

from app.config import settings
from app.providers import registry
from app.providers.base import PaperMetadata

# Bound at import time, before the autouse fixture stubs it out.
real_handle_check = registry.doi_handle_exists


class _Provider:
    name = "fake"

    def __init__(self, result=None, error: Exception | None = None, delay: float = 0):
        self.result = result
        self.error = error
        self.delay = delay
        self.calls: list[str] = []

    async def lookup_by_doi(self, doi):
        self.calls.append(doi)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return self.result


def _paper() -> PaperMetadata:
    return PaperMetadata(
        canonical_key="doi:10.1/x",
        paper_group_key="group:x",
        title="Found",
        publication_date=date(2024, 1, 1),
        provider_source="crossref",
    )


def _handle(exists: bool | None):
    async def check(_doi):
        return exists

    return check


@pytest.mark.asyncio
async def test_first_hit_wins_and_later_providers_are_skipped(monkeypatch):
    miss, hit, never = _Provider(), _Provider(_paper()), _Provider(_paper())
    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", [miss, hit, never])

    lookup = await registry.resolve_doi("10.1/x")

    assert lookup.status == "found"
    assert lookup.paper.title == "Found"
    assert never.calls == []


@pytest.mark.asyncio
async def test_empty_chain_or_any_failure_is_unavailable(monkeypatch):
    assert (await registry.resolve_doi("10.1/x")).status == "unavailable"

    monkeypatch.setattr(
        registry, "LOOKUP_DOI_CHAIN", [_Provider(error=RuntimeError("down")), _Provider()]
    )
    assert (await registry.resolve_doi("10.1/x")).status == "unavailable"


@pytest.mark.asyncio
async def test_all_misses_are_confirmed_with_the_handle_api(monkeypatch):
    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", [_Provider(), _Provider()])

    monkeypatch.setattr(registry, "doi_handle_exists", _handle(False))
    assert (await registry.resolve_doi("10.1/x")).status == "not_found"

    # Registered (e.g. DataCite) but described by no provider: pending, not rejected.
    monkeypatch.setattr(registry, "doi_handle_exists", _handle(True))
    assert (await registry.resolve_doi("10.1/x")).status == "unavailable"

    # doi.org unreachable: the miss is unconfirmed, so it is not rejected.
    monkeypatch.setattr(registry, "doi_handle_exists", _handle(None))
    assert (await registry.resolve_doi("10.1/x")).status == "unavailable"


@pytest.mark.asyncio
async def test_lookup_by_doi_skips_the_handle_check(monkeypatch):
    async def exploding(_doi):
        raise AssertionError("handle check must not run for plain lookups")

    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", [_Provider()])
    monkeypatch.setattr(registry, "doi_handle_exists", exploding)

    assert await registry.lookup_by_doi("10.1/x") is None


@pytest.mark.asyncio
async def test_resolution_is_bounded_by_the_timeout(monkeypatch):
    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", [_Provider(_paper(), delay=5)])
    monkeypatch.setattr(settings, "doi_resolve_timeout_seconds", 0.05)

    assert (await registry.resolve_doi("10.1/x")).status == "unavailable"


@pytest.mark.asyncio
@respx.mock
async def test_handle_api_answers():
    respx.get("https://doi.org/api/handles/10.5281/zenodo.1").mock(
        return_value=Response(200, json={"responseCode": 1, "handle": "10.5281/zenodo.1"})
    )
    respx.get("https://doi.org/api/handles/10.5281/nope").mock(
        return_value=Response(404, json={"responseCode": 100})
    )
    respx.get("https://doi.org/api/handles/10.5281/broken").mock(return_value=Response(500))

    assert await real_handle_check("10.5281/zenodo.1") is True
    assert await real_handle_check("10.5281/nope") is False
    assert await real_handle_check("10.5281/broken") is None


@pytest.mark.asyncio
@respx.mock
async def test_provider_urls_quote_the_doi():
    doi = "10.1000/a#b?c"
    openalex = respx.get(url__regex=r"https://api\.openalex\.org/works/doi:10\.1000/a%23b%3Fc")
    openalex.mock(return_value=Response(404))
    crossref = respx.get(url__regex=r"https://api\.crossref\.org/works/10\.1000/a%23b%3Fc")
    crossref.mock(return_value=Response(404))

    assert await registry.get_provider("openalex").lookup_by_doi(f"https://doi.org/{doi}") is None
    assert await registry.get_provider("crossref").lookup_by_doi(f"doi:{doi}") is None
    assert openalex.called
    assert crossref.called
