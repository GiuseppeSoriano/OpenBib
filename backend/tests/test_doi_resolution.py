"""DOI resolution outcomes across the provider chain and the doi.org handle check."""

import asyncio
import json
from datetime import date

import pytest
import respx
from httpx import Response

from app.config import settings
from app.providers import registry
from app.providers.base import PaperMetadata
from app.providers.rate_limiter import ProviderRateLimiter
from app.providers.semantic_scholar import DEFAULT_RETRY_AFTER, ProviderError

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


async def _exploding(_doi):
    raise AssertionError("the doi.org handle check must not run here")


@pytest.mark.asyncio
async def test_lookup_by_doi_skips_the_handle_check(monkeypatch, s2_mock):
    monkeypatch.setattr(registry, "doi_handle_exists", _exploding)
    s2_mock.responses.append(Response(404))

    assert await registry.lookup_by_doi("10.1/x") is None
    assert len(s2_mock.calls) == 1


@pytest.mark.asyncio
async def test_resolution_is_bounded_by_the_timeout(monkeypatch):
    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", [_Provider(_paper(), delay=5)])
    monkeypatch.setattr(settings, "doi_resolve_timeout_seconds", 0.05)

    timed_out = await registry.resolve_doi("10.1/x")
    assert (timed_out.status, timed_out.retry_after) == ("unavailable", DEFAULT_RETRY_AFTER)


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
async def test_provider_url_quotes_the_doi(s2_mock):
    doi = "10.1000/a#b?c"
    s2_mock.responses.extend([Response(404)] * 2)

    assert await registry.lookup_by_doi(f"https://doi.org/{doi}") is None
    assert await registry.lookup_by_id(f"doi:{doi}") is None
    # Only the DOI is percent-encoded; the ``DOI:`` prefix stays literal.
    for call in s2_mock.calls:
        assert call.url.raw_path.startswith(b"/graph/v1/paper/DOI:10.1000%2Fa%23b%3Fc?")


@pytest.mark.asyncio
async def test_chain_failures_carry_retry_after_and_unreadable_dois_are_misses(monkeypatch):
    limited = ProviderError("provider_rate_limited", "busy", retry_after=12)
    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", [_Provider(error=limited)])
    lookup = await registry.resolve_doi("10.1/x")
    assert (lookup.status, lookup.retry_after) == ("unavailable", 12)

    unreadable = ProviderError("invalid_query", "bad", 422)
    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", [_Provider(error=unreadable)])
    monkeypatch.setattr(registry, "doi_handle_exists", _handle(False))
    assert (await registry.resolve_doi("10.1/x")).status == "not_found"


def _found(doi: str) -> dict:
    return {"paperId": "a" * 40, "title": "Found", "externalIds": {"DOI": doi}}


@pytest.mark.asyncio
async def test_resolve_dois_batches_and_checks_only_the_misses(monkeypatch, s2_mock):
    checked: list[str] = []

    async def handle(doi):
        checked.append(doi)
        return not doi.endswith("gone")

    monkeypatch.setattr(registry, "doi_handle_exists", handle)
    s2_mock.responses.append([_found("10.1/found"), None, None])

    result = await registry.resolve_dois(["10.1/found", "10.1/gone", "10.1/datacite", "10.1/found"])

    assert len(s2_mock.calls) == 1
    assert json.loads(s2_mock.calls[0].content)["ids"] == [
        "DOI:10.1/found",
        "DOI:10.1/gone",
        "DOI:10.1/datacite",
    ]
    assert {doi: lookup.status for doi, lookup in result.items()} == {
        "10.1/found": "found",
        "10.1/gone": "not_found",
        "10.1/datacite": "unavailable",
    }
    assert result["10.1/found"].paper.title == "Found"
    assert sorted(checked) == ["10.1/datacite", "10.1/gone"]
    assert await registry.resolve_dois([]) == {}


@pytest.mark.asyncio
async def test_resolve_dois_bounds_the_handle_checks(monkeypatch, s2_mock):
    monkeypatch.setattr(settings, "import_resolve_concurrency", 2)
    active = peak = 0

    async def handle(_doi):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return True

    monkeypatch.setattr(registry, "doi_handle_exists", handle)
    s2_mock.responses.append([None] * 6)

    result = await registry.resolve_dois([f"10.1/{n}" for n in range(6)])

    assert peak == 2
    assert {lookup.status for lookup in result.values()} == {"unavailable"}


@pytest.mark.asyncio
async def test_resolve_dois_provider_failure_saves_nothing_as_missing(monkeypatch, s2_mock):
    monkeypatch.setattr(registry, "doi_handle_exists", _exploding)
    s2_mock.responses.extend([Response(429)] * 3)

    result = await registry.resolve_dois(["10.1/a", "10.1/b"])

    assert [(r.status, r.retry_after) for r in result.values()] == [
        ("unavailable", DEFAULT_RETRY_AFTER)
    ] * 2


@pytest.mark.asyncio
async def test_resolve_dois_without_a_key_is_unavailable():
    result = await registry.resolve_dois(["10.1/a"])
    assert (result["10.1/a"].status, result["10.1/a"].retry_after) == ("unavailable", None)


@pytest.mark.asyncio
async def test_resolve_dois_isolates_an_unreadable_doi(monkeypatch, s2_mock):
    monkeypatch.setattr(registry, "doi_handle_exists", _handle(False))

    def answer(request):
        if request.method == "POST" or "bad" in request.url.path:
            return Response(400, json={"error": "Invalid id"})
        return Response(200, json=_found("10.1/a"))

    s2_mock.handler = answer

    result = await registry.resolve_dois(["10.1/a", "10.1/bad"])

    assert (result["10.1/a"].status, result["10.1/bad"].status) == ("found", "not_found")
    assert [c.method for c in s2_mock.calls] == ["POST", "GET", "GET"]


@pytest.mark.asyncio
async def test_resolve_dois_budget_keeps_finished_results(monkeypatch, s2_mock):
    async def slow(_doi):
        await asyncio.sleep(5)
        return True

    monkeypatch.setattr(registry, "doi_handle_exists", slow)
    s2_mock.responses.append([_found("10.1/found"), None])

    result = await registry.resolve_dois(["10.1/found", "10.1/slow"], timeout=0.05)

    assert (result["10.1/found"].status, result["10.1/slow"].status) == ("found", "unavailable")


@pytest.mark.asyncio
async def test_resolve_dois_without_confirmation_skips_doi_org(monkeypatch, s2_mock):
    monkeypatch.setattr(registry, "doi_handle_exists", _exploding)
    s2_mock.responses.append([None])

    result = await registry.resolve_dois(["10.1/x"], confirm_missing=False)

    assert result["10.1/x"].status == "not_found"


@pytest.mark.asyncio
async def test_resolve_dois_uses_the_test_chain(monkeypatch):
    hit = _Provider(_paper())
    monkeypatch.setattr(registry, "LOOKUP_DOI_CHAIN", [hit])

    result = await registry.resolve_dois(["10.1/x", "10.1/y"])

    assert {lookup.status for lookup in result.values()} == {"found"}
    assert sorted(hit.calls) == ["10.1/x", "10.1/y"]


@pytest.mark.asyncio
async def test_resolve_id_outcomes(monkeypatch, s2_mock):
    monkeypatch.setattr(registry, "doi_handle_exists", _handle(False))

    def answer(request):
        path = request.url.path
        if path.endswith("/found") or path.endswith("DOI:10.1/found"):
            return Response(200, json=_found("10.1/found"))
        if "ARXIV:" in path:
            return Response(400, json={"error": "Invalid id"})
        if "PMCID:" in path:
            return Response(429)
        return Response(404)

    s2_mock.handler = answer

    assert (await registry.resolve_id("s2:found")).paper.title == "Found"
    assert (await registry.resolve_id("doi:10.1/found")).status == "found"
    assert (await registry.resolve_id("pmid:404")).status == "not_found"
    assert (await registry.resolve_id("arxiv:2501.00001")).status == "not_found"
    # A DOI miss is confirmed with doi.org; other identifiers need no check.
    assert (await registry.resolve_id("doi:10.1/gone")).status == "not_found"
    busy = await registry.resolve_id("pmcid:PMC1")
    assert (busy.status, busy.retry_after) == ("unavailable", DEFAULT_RETRY_AFTER)


@pytest.mark.asyncio
async def test_resolve_id_is_bounded_by_the_timeout(monkeypatch, s2_mock):
    async def slow(_identifier):
        await asyncio.sleep(5)

    monkeypatch.setattr(s2_mock.provider, "lookup_by_id", slow)
    monkeypatch.setattr(settings, "doi_resolve_timeout_seconds", 0.05)

    timed_out = await registry.resolve_id("s2:" + "a" * 40)
    assert (timed_out.status, timed_out.retry_after) == ("unavailable", DEFAULT_RETRY_AFTER)


@pytest.mark.asyncio
async def test_rate_limited_identifier_reports_retry_after_within_the_budget(monkeypatch, s2_mock):
    # Real pacing, backoff and budget, every wait scaled by 1/100.
    s2_mock.provider._limiter = ProviderRateLimiter(calls_per_second=100, min_delay=0.02)
    s2_mock.provider._sleep = lambda delay: asyncio.sleep(delay / 100)
    monkeypatch.setattr(settings, "doi_resolve_timeout_seconds", 0.15)
    s2_mock.responses.extend([Response(429)] * 6)

    for identifier in ("s2:" + "a" * 40, "doi:10.1/busy"):
        busy = await registry.resolve_id(identifier)
        assert (busy.status, busy.retry_after) == ("unavailable", DEFAULT_RETRY_AFTER)
    # Both lookups gave up after their third attempt, not on the timeout.
    assert len(s2_mock.calls) == 6
