"""Opt-in live regressions: RUN_SEMANTIC_SCHOLAR_LIVE=1 pytest -m live -s.

Normal CI never needs credentials/network. Uses isolated test DB/Redis, not the
user's library. Do not record credentials or raw HTTP responses in test output.
"""

import os
from dataclasses import asdict

import httpx
import pytest
from pydantic import SecretStr

from app.config import Settings, settings
from app.dependencies import get_db
from app.graph import service as graph_service
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


@pytest.mark.skip(reason="integration: ported in WP3")
async def test_live_titans_graph_pipeline(db, live_provider, monkeypatch, redis_backend):
    meta = await registry.lookup_by_id(S2_ID)
    meta = (await service.cache_papers(db, [meta]))[0]
    reference = None
    for direction in ("cites", "cited_by"):
        # Force multi-page references; use normal production size for citations.
        monkeypatch.setattr(
            "app.providers.semantic_scholar.GRAPH_PAGE_SIZE", 100 if direction == "cites" else 1000
        )
        graph = await graph_service.expand_graph(
            db, redis_backend, from_keys=[meta.canonical_key], direction=direction, limit_per_node=5
        )
        assert graph.nodes and graph.edges
        if direction == "cites":
            reference = graph.nodes[0].selected_version
        ids = [n.selected_version.semantic_scholar_id for n in graph.nodes]
        assert len(ids) == len(set(ids))
    read = service.cached_paper_to_read(await service.get_cached_paper(db, meta.canonical_key))
    refs = await graph_service._fetch_referenced_ids(db, redis_backend, read)
    assert refs and reference.semantic_scholar_id in refs
    # Reuse expansion metadata and ID cache as in normal application workflows.
    base = await graph_service.build_base_graph(
        db, redis_backend, [meta.canonical_key, reference.canonical_key]
    )
    assert any(
        e.source == meta.paper_group_key and e.target == reference.paper_group_key
        for e in base.edges
    )
    print(
        f"Titans: {len(refs)} unique reference IDs; paginated references, citations, both expansion directions and base graph edges passed."
    )


async def test_live_invalid_key(live_provider, monkeypatch):
    monkeypatch.setattr(
        settings, "semantic_scholar_api_key", SecretStr("intentionally-invalid-test-key")
    )
    with pytest.raises(ProviderError) as error:
        await registry.lookup_by_id(S2_ID)
    assert error.value.status_code == 503 and "rejected" in error.value.detail
    print("Live invalid-key rejection passed.")
