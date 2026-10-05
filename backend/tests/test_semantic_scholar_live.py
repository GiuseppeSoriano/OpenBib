"""Opt-in live regressions: RUN_SEMANTIC_SCHOLAR_LIVE=1 pytest -m live -s.

Normal CI never needs credentials/network. Uses isolated test DB/Redis, not the
user's library. Do not record credentials or raw HTTP responses in test output.
"""

import os
from dataclasses import asdict
from datetime import UTC, datetime

import httpx
import pytest
from pydantic import SecretStr

from app.config import Settings, settings
from app.dependencies import get_db
from app.graph import related
from app.graph import service as graph_service
from app.graph.schemas import RelatedRangeRequest
from app.main import create_app
from app.papers import service
from app.providers import registry
from app.providers.base import SearchFilters
from app.providers.identity import deduplicate
from app.providers.rate_limiter import ProviderRateLimiter
from app.providers.semantic_scholar import ProviderError

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        os.getenv("RUN_SEMANTIC_SCHOLAR_LIVE") != "1",
        reason="Opt-in live Semantic Scholar API test",
    ),
]
TITLE = "Titans: Learning to Memorize at Test Time"
S2_ID = "5e7a795d89910634f001cc3a631023f1dd4e2e23"


@pytest.fixture
async def live_provider(monkeypatch):
    key = Settings().semantic_scholar_api_key
    if not key.get_secret_value():
        pytest.skip("SEMANTIC_SCHOLAR_API_KEY is missing")
    monkeypatch.setattr(settings, "semantic_scholar_api_key", key)
    monkeypatch.setattr(registry, "_instances", {})
    # Cold integration workloads are paced below the production budget.
    registry.get_provider()._limiter = ProviderRateLimiter(calls_per_second=0.2)
    yield
    await registry.close_providers()


async def test_live_titans_discovery_pipeline(db, live_provider):
    app = create_app()

    async def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as api:
        response = await api.get("/api/v1/papers/search", params={"q": TITLE, "size": 5})
        assert response.status_code == 200, response.json()
        payload = response.json()
        papers = [item.get("paper") or item["selected_version"] for item in payload["items"]]
        matches = [p for p in papers if p["semantic_scholar_id"] == S2_ID]
        assert len(matches) == 1
        paper = matches[0]
        assert paper["title"] == TITLE and paper["arxiv_id"] == "2501.00663"
        assert len(paper["authors"]) == 3 and "Behrouz" in paper["authors"][0]["name"]
        assert all(a["semantic_scholar_id"] for a in paper["authors"])
        assert paper["abstract"] and paper["doi"]
        detail = await api.get("/api/v1/papers/" + paper["canonical_key"])
        assert detail.status_code == 200 and detail.json()["semantic_scholar_id"] == S2_ID
    by_id = await registry.lookup_by_id(S2_ID)
    by_doi = await registry.lookup_by_doi(paper["doi"])
    by_arxiv = await registry.lookup_by_arxiv_id("2501.00663v1")
    assert asdict(by_id) == asdict(by_doi) == asdict(by_arxiv)
    assert service.serialize_paper_metadata(by_id) == paper
    assert len(deduplicate([by_id, by_doi, by_arxiv])) == 1
    page2 = await registry.search(TITLE, SearchFilters(), page=2, size=1)
    assert page2.page == 2 and page2.papers
    print(
        "Titans: title/DOI/arXiv/S2 metadata identical; 3 authors with IDs; no duplicate representations; search pagination passed."
    )


async def test_live_titans_graph_pipeline(db, live_provider, redis_backend):
    meta = await registry.lookup_by_id(S2_ID)
    meta = (await service.cache_papers(db, [meta]))[0]
    reference = None
    for direction in ("cites", "cited_by"):
        req = RelatedRangeRequest(
            source_key=meta.canonical_key,
            source_group_key=meta.paper_group_key,
            direction=direction,
        )
        source = await related.load_source(db, req.source_key, req.source_group_key)
        # One request collects up to 4,000 records; ask again, as the client
        # does, while the list is still being ranked.
        for _ in range(3):
            ranged = await related.related_range(db, redis_backend, req, source, set())
            if ranged.reason != "ranking":
                break
        assert ranged.reason is None
        # The total is exact once the ranked list fits one 1,000-entry chunk.
        assert ranged.total_exact or ranged.scanned > 1000
        assert ranged.nodes and ranged.edges and ranged.provider_total
        counts = [n.selected_version.cited_by_count or 0 for n in ranged.nodes]
        assert counts == sorted(counts, reverse=True)
        ids = [n.selected_version.semantic_scholar_id for n in ranged.nodes]
        assert len(ids) == len(set(ids))
        if direction == "cites":
            reference = ranged.nodes[0].selected_version
    refs = await registry.references_batch([S2_ID])
    assert reference.semantic_scholar_id in refs[S2_ID]
    # Reuse range metadata and the reference-id cache as the application does.
    base = await graph_service.build_base_graph(
        db, redis_backend, [meta.canonical_key, reference.canonical_key]
    )
    assert not base.edges_partial
    assert any(
        e.source == meta.paper_group_key and e.target == reference.paper_group_key
        for e in base.edges
    )
    print(
        f"Titans: {len(refs[S2_ID])} reference IDs; ranked citation and reference ranges and base graph edges passed."
    )


async def test_live_invalid_key(live_provider, monkeypatch):
    monkeypatch.setattr(
        settings, "semantic_scholar_api_key", SecretStr("intentionally-invalid-test-key")
    )
    with pytest.raises(ProviderError) as error:
        await registry.lookup_by_id(S2_ID)
    assert error.value.status_code == 503 and error.value.code == "provider_key_rejected"
    print("Live invalid-key rejection passed.")


async def test_live_batch_bulk_and_related_paging(live_provider):
    doi = "10.1109/tnn.2008.2005605"
    found, missing = await registry.papers_by_ids(["DOI:" + doi, "DOI:10.9999/missing.x"])
    assert found is not None and found.doi == doi and missing is None
    resolved = await registry.resolve_dois([doi])
    assert resolved[doi].status == "found"
    refs = await registry.references_batch([found.semantic_scholar_id])
    assert len(refs[found.semantic_scholar_id]) > 50
    # "Attention Is All You Need" has far more than 10,000 citers.
    (attention,) = await registry.papers_by_ids(["ARXIV:1706.03762"])
    page = await registry.related_page(attention.semantic_scholar_id, "cited_by", offset=9000)
    assert page.capped and page.exhausted and len(page.entries) > 900
    assert all(entry[1].startswith(("doi:", "s2:")) for entry in page.entries)
    batch = await registry.search_sorted("graph neural networks", sort="citations")
    assert batch.total > 1000 and batch.token and len(batch.items) > 900
    counts = [p.cited_by_count or 0 for p in batch.items]
    assert counts[:50] == sorted(counts[:50], reverse=True)
    recent = await registry.search_sorted("graph neural networks", sort="date")
    today = datetime.now(UTC).date()
    assert all(p.publication_date is None or p.publication_date <= today for p in recent.items)
    print("Batch lookup, batch references, capped citation paging and bulk sorts passed.")
