from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from reference_manager.config import AppConfig
from reference_manager.providers import ProviderRegistry
from reference_manager.service import ReferenceManagerService


def openalex_work(
    work_id: str,
    doi: str,
    title: str,
    year: int,
    *,
    venue: str,
    authors: list[str],
    referenced: list[str],
    cited_by_filter: str | None,
    cited_by_count: int = 3,
) -> dict:
    return {
        "id": f"https://openalex.org/{work_id}",
        "doi": f"https://doi.org/{doi}",
        "display_name": title,
        "publication_year": year,
        "publication_date": f"{year}-01-01",
        "type": "journal-article",
        "language": "en",
        "ids": {"pmid": None, "pmcid": None},
        "primary_location": {
            "landing_page_url": f"https://example.org/{work_id.lower()}",
            "pdf_url": f"https://example.org/{work_id.lower()}.pdf",
            "source": {"display_name": venue},
        },
        "authorships": [
            {
                "author": {"display_name": name, "id": f"https://openalex.org/A{index + 1}", "orcid": None},
                "institutions": [{"display_name": f"Institute {index + 1}"}],
            }
            for index, name in enumerate(authors)
        ],
        "referenced_works": [f"https://openalex.org/{item}" for item in referenced],
        "cited_by_api_url": f"https://api.openalex.org/works?filter=cites:{cited_by_filter}" if cited_by_filter else None,
        "topics": [{"display_name": "literature discovery"}],
        "keywords": [{"display_name": "citation graph"}],
        "concepts": [{"display_name": "academic search"}],
        "abstract_inverted_index": {"Visual": [0], "scholarly": [1], "discovery": [2]},
        "cited_by_count": cited_by_count,
    }


OPENALEX_FIXTURES = {
    "W1001": openalex_work(
        "W1001",
        "10.1000/litdisc.2020.001",
        "Visual Discovery for Scholarly Graph Exploration",
        2020,
        venue="Journal of Scholarly Systems",
        authors=["Elena Marino", "Marco Berti"],
        referenced=["W1003"],
        cited_by_filter="W1001",
    ),
    "W1003": openalex_work(
        "W1003",
        "10.1000/litdisc.2018.003",
        "Seed Papers and Citation Chaining in Literature Reviews",
        2018,
        venue="Review Science Quarterly",
        authors=["Marco Berti", "Giulia Rinaldi"],
        referenced=[],
        cited_by_filter="W1003",
    ),
    "W1004": openalex_work(
        "W1004",
        "10.1000/litdisc.2021.004",
        "Explainable Scholarly Recommendations with Feedback Loops",
        2021,
        venue="ACM Knowledge Interfaces",
        authors=["Sara Valli", "Laura Conti"],
        referenced=["W1001"],
        cited_by_filter="W1004",
    ),
    "W1008": openalex_work(
        "W1008",
        "10.1000/litdisc.2023.008",
        "Collaborative Curation of Shared Reference Collections",
        2023,
        venue="Collaborative Systems Letters",
        authors=["Sara Valli", "Enrico Fontana"],
        referenced=["W1004"],
        cited_by_filter="W1008",
    ),
    "W1009": openalex_work(
        "W1009",
        "10.1000/litdisc.2024.009",
        "Robust Bibliographic Reconciliation Across Metadata Providers",
        2024,
        venue="Metadata Engineering Journal",
        authors=["Enrico Fontana", "Elena Marino"],
        referenced=["W1003"],
        cited_by_filter="W1009",
    ),
    "W4406032263": openalex_work(
        "W4406032263",
        "10.48550/arxiv.2501.00663",
        "Titans: Learning to Memorize at Test Time",
        2024,
        venue="arXiv (Cornell University)",
        authors=["Ali Behrouz", "Peilin Zhong", "Vahab Mirrokni"],
        referenced=[],
        cited_by_filter=None,
        cited_by_count=6,
    ),
    "W4406031111": openalex_work(
        "W4406031111",
        "10.1000/titans.ref.001",
        "Memory-Augmented Sequence Models for Long Contexts",
        2023,
        venue="Neural Sequence Journal",
        authors=["A. Researcher"],
        referenced=[],
        cited_by_filter=None,
        cited_by_count=1,
    ),
    "W4406032222": openalex_work(
        "W4406032222",
        "10.1000/titans.cite.001",
        "Evaluating Titans for Extended Context Benchmarks",
        2025,
        venue="Benchmarks Letters",
        authors=["B. Evaluator"],
        referenced=[],
        cited_by_filter=None,
        cited_by_count=0,
    ),
    "W4406033333": openalex_work(
        "W4406033333",
        "10.1000/opencitations.ref.001",
        "Citation Graph Recovery with Open Data",
        2022,
        venue="Open Citation Systems",
        authors=["C. Graph"],
        referenced=[],
        cited_by_filter=None,
        cited_by_count=0,
    ),
    "W4406034444": openalex_work(
        "W4406034444",
        "10.1000/opencitations.cite.001",
        "Incoming Citation Discovery Beyond Primary Providers",
        2025,
        venue="Open Citation Systems",
        authors=["D. Fallback"],
        referenced=[],
        cited_by_filter=None,
        cited_by_count=0,
    ),
}


class MockTransport:
    def __init__(self) -> None:
        self.calls: dict[str, int] = {}

    def get_json(self, url: str, *, headers=None, timeout: int = 20):
        self.calls[url] = self.calls.get(url, 0) + 1
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Flitdisc.2020.001" in url:
            return OPENALEX_FIXTURES["W1001"]
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Flitdisc.2021.004" in url:
            return OPENALEX_FIXTURES["W1004"]
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Flitdisc.2023.008" in url:
            return OPENALEX_FIXTURES["W1008"]
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Flitdisc.2024.009" in url:
            return OPENALEX_FIXTURES["W1009"]
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.48550%2Farxiv.2501.00663" in url:
            return OPENALEX_FIXTURES["W4406032263"]
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Fopencitations.ref.001" in url:
            return OPENALEX_FIXTURES["W4406033333"]
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Fopencitations.cite.001" in url:
            return OPENALEX_FIXTURES["W4406034444"]
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Fopencitations.missing.001" in url:
            return {
                **OPENALEX_FIXTURES["W4406032263"],
                "id": "https://openalex.org/W4406099999",
                "doi": "https://doi.org/10.1000/opencitations.missing.001",
                "display_name": "Sparse Provider Coverage for Citation Testing",
                "referenced_works": [],
                "cited_by_api_url": None,
                "cited_by_count": 0,
            }
        if "api.openalex.org/works/W1001" in url:
            return OPENALEX_FIXTURES["W1001"]
        if "api.openalex.org/works/W1003" in url:
            return OPENALEX_FIXTURES["W1003"]
        if "api.openalex.org/works/W1004" in url:
            return OPENALEX_FIXTURES["W1004"]
        if "api.openalex.org/works/W1008" in url:
            return OPENALEX_FIXTURES["W1008"]
        if "api.openalex.org/works/W1009" in url:
            return OPENALEX_FIXTURES["W1009"]
        if "api.openalex.org/works/W4406032263" in url:
            return OPENALEX_FIXTURES["W4406032263"]
        if "api.openalex.org/works/W4406031111" in url:
            return OPENALEX_FIXTURES["W4406031111"]
        if "api.openalex.org/works/W4406032222" in url:
            return OPENALEX_FIXTURES["W4406032222"]
        if "api.openalex.org/works/W4406033333" in url:
            return OPENALEX_FIXTURES["W4406033333"]
        if "api.openalex.org/works/W4406034444" in url:
            return OPENALEX_FIXTURES["W4406034444"]
        if "api.openalex.org/works?search=" in url:
            lowered = url.lower()
            if "titans" in lowered:
                return {"meta": {"count": 1}, "results": [OPENALEX_FIXTURES["W4406032263"]]}
            return {"meta": {"count": 2}, "results": [OPENALEX_FIXTURES["W1001"], OPENALEX_FIXTURES["W1004"]]}
        if "api.openalex.org/works/W4406099999" in url:
            return {
                **OPENALEX_FIXTURES["W4406032263"],
                "id": "https://openalex.org/W4406099999",
                "doi": "https://doi.org/10.1000/opencitations.missing.001",
                "display_name": "Sparse Provider Coverage for Citation Testing",
                "referenced_works": [],
                "cited_by_api_url": None,
                "cited_by_count": 0,
            }
        if "filter=cites%3AW1001" in url or "filter=cites:W1001" in url:
            return {"meta": {"count": 1}, "results": [OPENALEX_FIXTURES["W1004"]]}
        if "filter=cited_by%3AW1001" in url or "filter=cited_by:W1001" in url:
            return {"meta": {"count": 1}, "results": [OPENALEX_FIXTURES["W1003"]]}
        if "filter=cites%3AW1004" in url or "filter=cites:W1004" in url:
            return {"meta": {"count": 0}, "results": []}
        if "filter=cited_by%3AW1004" in url or "filter=cited_by:W1004" in url:
            return {"meta": {"count": 1}, "results": [OPENALEX_FIXTURES["W1001"]]}
        if "filter=cites%3AW1008" in url or "filter=cites:W1008" in url:
            return {"meta": {"count": 0}, "results": []}
        if "filter=cited_by%3AW1008" in url or "filter=cited_by:W1008" in url:
            return {"meta": {"count": 1}, "results": [OPENALEX_FIXTURES["W1004"]]}
        if "filter=cites%3AW1009" in url or "filter=cites:W1009" in url:
            return {"meta": {"count": 0}, "results": []}
        if "filter=cited_by%3AW1009" in url or "filter=cited_by:W1009" in url:
            return {"meta": {"count": 1}, "results": [OPENALEX_FIXTURES["W1003"]]}
        if "filter=cited_by%3AW4406032263" in url or "filter=cited_by:W4406032263" in url:
            return {"meta": {"count": 1}, "results": [OPENALEX_FIXTURES["W4406031111"]]}
        if "filter=cites%3AW4406032263" in url or "filter=cites:W4406032263" in url:
            return {"meta": {"count": 1}, "results": [OPENALEX_FIXTURES["W4406032222"]]}
        if "filter=cited_by%3AW4406099999" in url or "filter=cited_by:W4406099999" in url:
            return {"meta": {"count": 0}, "results": []}
        if "filter=cites%3AW4406099999" in url or "filter=cites:W4406099999" in url:
            return {"meta": {"count": 0}, "results": []}
        if "api.crossref.org/works/" in url:
            doi = url.split("/works/", 1)[1].split("?", 1)[0].replace("%2F", "/")
            return {
                "message": {
                    "DOI": doi,
                    "title": [OPENALEX_FIXTURES["W1001"]["display_name"] if doi.endswith("2020.001") else "Crossref enriched title"],
                    "type": "journal-article",
                    "container-title": ["Crossref Journal"],
                    "issued": {"date-parts": [[2020, 1, 1]]},
                    "reference": [{"DOI": "10.1000/litdisc.2018.003", "article-title": "Seed Papers and Citation Chaining in Literature Reviews"}],
                    "is-referenced-by-count": 2,
                    "references-count": 1,
                    "author": [{"given": "Elena", "family": "Marino", "affiliation": [{"name": "Institute 1"}]}],
                    "URL": f"https://doi.org/{doi}",
                }
            }
        if "api.crossref.org/works?" in url:
            return {"message": {"items": []}}
        if "api.opencitations.net/index/v2/references/doi:10.1000/opencitations.missing.001" in url or "api.opencitations.net/index/v2/references/doi:10.1000%2Fopencitations.missing.001" in url:
            return [
                {
                    "oci": "oci:1-1",
                    "citing": "doi:10.1000/opencitations.missing.001",
                    "cited": "doi:10.1000/opencitations.ref.001",
                    "creation": "2024-01-01",
                }
            ]
        if "api.opencitations.net/index/v2/citations/doi:10.1000/opencitations.missing.001" in url or "api.opencitations.net/index/v2/citations/doi:10.1000%2Fopencitations.missing.001" in url:
            return [
                {
                    "oci": "oci:1-2",
                    "citing": "doi:10.1000/opencitations.cite.001",
                    "cited": "doi:10.1000/opencitations.missing.001",
                    "creation": "2025-01-01",
                }
            ]
        if "api.opencitations.net/index/v2/references/" in url or "api.opencitations.net/index/v2/citations/" in url:
            return []
        if "europepmc" in url:
            return {"resultList": {"result": []}}
        raise AssertionError(f"Unexpected URL requested in test: {url}")


class ReferenceManagerServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tempdir.name) / "test.sqlite3")
        self.config = AppConfig(
            openalex_api_key="test-openalex-key",
            opencitations_access_token=None,
            crossref_mailto="tests@example.com",
            europepmc_enabled=True,
            europepmc_email="tests@example.com",
            request_timeout_seconds=5,
            max_related_works=25,
            provider_cache_ttl_seconds=3600,
            search_cache_ttl_seconds=1800,
            reference_cache_ttl_seconds=7200,
            citation_cache_ttl_seconds=1800,
        )
        self.transport = MockTransport()
        self.providers = ProviderRegistry(self.config, transport=self.transport)
        self.service = ReferenceManagerService(self.db_path, config=self.config, providers=self.providers)
        self.user = self.service.register_user("owner@example.com", "secret123", "Owner")["user"]
        self.other = self.service.register_user("editor@example.com", "secret123", "Editor")["user"]

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_merge_preserves_notes_and_collection_presence(self) -> None:
        collection = self.service.create_collection(self.user["id"], "Core Papers")
        first = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2020.001", collection_id=collection["id"])["paper"]
        second = self.service.add_paper(
            self.user["id"],
            identifier_type="manual",
            metadata={
                "title": "Visual Discovery for Scholarly Graph Exploration (Preprint)",
                "authors": ["Elena Marino", "Marco Berti"],
                "year": 2020,
                "abstract": "Duplicate manual variant.",
                "manual": True,
            },
            collection_id=collection["id"],
        )["paper"]
        note = self.service.add_note(self.user["id"], {"target_type": "paper", "target_id": second["id"], "body": "Investigate duplicate.", "visibility": "private"})
        self.service.merge_papers(self.user["id"], first["id"], second["id"], "manual duplicate")
        merged = self.service.get_paper(first["id"])
        self.assertTrue(any(item["body"] == note["body"] for item in merged["notes"]))
        updated_collection = self.service.get_collection(self.user["id"], collection["id"])
        self.assertEqual(updated_collection["papers"][0]["id"], first["id"])

    def test_backend_ingests_references_and_citations_with_provenance(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2020.001")["paper"]
        relation_types = {item["relation_type"] for item in paper["relations"]}
        self.assertIn("cites", relation_types)
        self.assertIn("cited_by", relation_types)
        self.assertEqual(len(paper["graph"]["references"]), 1)
        self.assertEqual(len(paper["graph"]["citations"]), 1)
        self.assertEqual(paper["graph"]["references"][0]["edge"]["state"], "retrieved")
        self.assertEqual(paper["graph"]["citations"][0]["edge"]["state"], "retrieved")
        self.assertTrue(any(source["provider"] == "openalex" for source in paper["sources"]))
        self.assertIsNotNone(paper["retrieval"])
        workspace_papers = self.service.list_workspace_papers(self.user["id"])
        self.assertEqual(len(workspace_papers), 1)
        self.assertTrue(workspace_papers[0]["user_context"]["saved_by_user"])

    def test_external_search_results_do_not_enter_library_until_saved(self) -> None:
        result = self.service.search_papers(self.user["id"], "titans")
        self.assertGreaterEqual(len(result["external_results"]), 1)
        self.assertEqual(len(self.service.list_workspace_papers(self.user["id"])), 0)
        external = result["external_results"][0]
        self.assertIsNotNone(external["discovery_id"])
        self.assertTrue(external["user_context"]["discovered_only"])
        saved = self.service.save_discovery_paper(self.user["id"], external["discovery_id"])
        self.assertTrue(saved["paper"]["user_context"]["saved_by_user"])
        self.assertEqual(len(self.service.list_workspace_papers(self.user["id"])), 1)

    def test_collection_membership_implies_library_entry(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2020.001")["paper"]
        collection = self.service.create_collection(self.user["id"], "Reading Queue", seed_paper_ids=[paper["id"]])
        self.assertEqual(collection["papers"][0]["id"], paper["id"])
        library = self.service.list_workspace_papers(self.user["id"])
        self.assertEqual(len(library), 1)
        self.assertEqual(library[0]["user_context"]["in_collections_count"], 1)

    def test_sqlite_projection_stores_are_materialized(self) -> None:
        collection = self.service.create_collection(self.user["id"], "Projection Test")
        paper = self.service.add_paper(
            self.user["id"],
            identifier_type="doi",
            value="10.1000/litdisc.2020.001",
            collection_id=collection["id"],
        )["paper"]
        with sqlite3.connect(self.service.read_model_store.db_path) as connection:
            library_view = connection.execute(
                "SELECT payload_json FROM projection_views WHERE view_type = 'library' AND view_key = ?",
                (str(self.user["id"]),),
            ).fetchone()
            collection_view = connection.execute(
                "SELECT payload_json FROM projection_views WHERE view_type = 'collection' AND view_key = ?",
                (f"{self.user['id']}:{collection['id']}",),
            ).fetchone()
        with sqlite3.connect(self.service.graph_store.db_path) as connection:
            saved_edge = connection.execute(
                "SELECT payload_json FROM graph_projection_edges WHERE edge_key = ?",
                (f"user:{self.user['id']}->saved->paper:{paper['id']}",),
            ).fetchone()
            contains_edge = connection.execute(
                "SELECT payload_json FROM graph_projection_edges WHERE edge_key = ?",
                (f"collection:{collection['id']}->contains->paper:{paper['id']}",),
            ).fetchone()
        self.assertIsNotNone(library_view)
        self.assertIsNotNone(collection_view)
        self.assertIsNotNone(saved_edge)
        self.assertIsNotNone(contains_edge)

    def test_system_status_reports_storage_topology(self) -> None:
        status = self.service.system_status()
        self.assertEqual(status["stores"]["transactional"]["backend"], "sqlite")
        self.assertEqual(status["stores"]["graph"]["backend"], "sqlite")
        self.assertEqual(status["stores"]["read_models"]["backend"], "sqlite")

    def test_live_relations_are_fetched_and_cached(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2020.001")["paper"]
        first_call_count = sum(self.transport.calls.values())
        live = self.service.get_live_relations(self.user["id"], paper["id"], direction="all", force_refresh=True)
        self.assertEqual(live["references"]["summary"]["count"], 1)
        self.assertEqual(live["citations"]["summary"]["count"], 1)
        self.assertIn("openalex", live["references"]["sources_used"])
        self.assertTrue(any(item["provider"] == "openalex" for item in live["references"]["coverage"]))
        second_call_count = sum(self.transport.calls.values())
        self.assertGreater(second_call_count, first_call_count)
        cached = self.service.get_live_relations(self.user["id"], paper["id"], direction="all", force_refresh=False)
        self.assertTrue(cached["cache_hit"])
        self.assertEqual(sum(self.transport.calls.values()), second_call_count)

    def test_live_relations_refresh_openalex_work_when_graph_hints_are_missing(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2020.001")["paper"]
        with self.service._connect() as connection:
            metadata = dict(paper["metadata"])
            metadata["graph_hints"] = {"openalex_id": "https://openalex.org/W1001", "referenced_works": [], "cited_by_api_url": None}
            connection.execute(
                "UPDATE papers SET metadata_json = ? WHERE id = ?",
                (json.dumps(metadata), paper["id"]),
            )
            connection.execute("DELETE FROM paper_relation_snapshots WHERE paper_id = ?", (paper["id"],))
            connection.commit()
        live = self.service.get_live_relations(self.user["id"], paper["id"], direction="all", force_refresh=True)
        self.assertEqual(live["references"]["summary"]["count"], 1)
        self.assertEqual(live["citations"]["summary"]["count"], 1)

    def test_titans_relations_are_recovered_from_openalex_filters(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.48550/arxiv.2501.00663")["paper"]
        live = self.service.get_live_relations(self.user["id"], paper["id"], direction="all", force_refresh=True)
        reference_titles = {item["paper"]["title"] for item in live["references"]["items"]}
        citation_titles = {item["paper"]["title"] for item in live["citations"]["items"]}
        self.assertIn(OPENALEX_FIXTURES["W4406031111"]["display_name"], reference_titles)
        self.assertIn(OPENALEX_FIXTURES["W4406032222"]["display_name"], citation_titles)
        self.assertGreaterEqual(live["references"]["summary"]["count"], 1)
        self.assertGreaterEqual(live["citations"]["summary"]["count"], 1)

    def test_empty_legacy_snapshots_are_invalidated_and_reloaded(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.48550/arxiv.2501.00663")["paper"]
        with self.service._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO paper_relation_snapshots (
                    paper_id, direction, status, items_json, summary_json, source_summary_json,
                    degraded_json, fetched_at, expires_at, updated_at
                ) VALUES (?, 'references', 'fresh', '[]', '{\"count\":0}', '[]', '[]', '2026-03-21T00:00:00+00:00', '2099-01-01T00:00:00+00:00', '2026-03-21T00:00:00+00:00')
                """,
                (paper["id"],),
            )
            connection.execute(
                """
                INSERT OR REPLACE INTO paper_relation_snapshots (
                    paper_id, direction, status, items_json, summary_json, source_summary_json,
                    degraded_json, fetched_at, expires_at, updated_at
                ) VALUES (?, 'citations', 'fresh', '[]', '{\"count\":0}', '[]', '[]', '2026-03-21T00:00:00+00:00', '2099-01-01T00:00:00+00:00', '2026-03-21T00:00:00+00:00')
                """,
                (paper["id"],),
            )
            connection.commit()
        live = self.service.get_live_relations(self.user["id"], paper["id"], direction="all", force_refresh=False)
        self.assertFalse(live["cache_hit"])
        reference_titles = {item["paper"]["title"] for item in live["references"]["items"]}
        citation_titles = {item["paper"]["title"] for item in live["citations"]["items"]}
        self.assertIn(OPENALEX_FIXTURES["W4406031111"]["display_name"], reference_titles)
        self.assertIn(OPENALEX_FIXTURES["W4406032222"]["display_name"], citation_titles)

    def test_opencitations_fallback_recovers_missing_openalex_relations(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/opencitations.missing.001")["paper"]
        live = self.service.get_live_relations(self.user["id"], paper["id"], direction="all", force_refresh=True)
        reference_dois = {item["paper"]["doi"] for item in live["references"]["items"]}
        citation_dois = {item["paper"]["doi"] for item in live["citations"]["items"]}
        self.assertIn("10.1000/opencitations.ref.001", reference_dois)
        self.assertIn("10.1000/opencitations.cite.001", citation_dois)
        self.assertGreaterEqual(live["references"]["summary"]["count"], 1)
        self.assertGreaterEqual(live["citations"]["summary"]["count"], 1)

    def test_citation_pagination_returns_slice_and_metadata(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.48550/arxiv.2501.00663")["paper"]
        with self.service._connect() as connection:
            self.service._save_relation_snapshot(
                connection,
                paper_id=paper["id"],
                direction="citations",
                items=[
                    {
                        "direction": "citations",
                        "relation_type": "cited_by",
                        "paper": {"id": index, "doi": f"10.1000/pagination.{index}", "title": f"Citation {index}", "venue": None, "year": 2025, "published_at": None, "quality_state": "completo", "reliability_state": "affidabile"},
                        "edge": {"state": "retrieved", "confidence": 1.0, "explanation": "test", "providers": ["openalex"], "discovered_via": ["citation"], "retrieved_at": "2026-03-21T00:00:00+00:00", "evidence_count": 1},
                    }
                    for index in range(1, 26)
                ],
                degraded=[],
                sources_used=["openalex"],
                expected_count=25,
            )
            connection.commit()
        page_one = self.service.get_live_relations(self.user["id"], paper["id"], direction="citations", force_refresh=False, citation_page=1, citation_page_size=10)
        page_two = self.service.get_live_relations(self.user["id"], paper["id"], direction="citations", force_refresh=False, citation_page=2, citation_page_size=10)
        self.assertEqual(len(page_one["citations"]["items"]), 10)
        self.assertEqual(len(page_two["citations"]["items"]), 10)
        self.assertEqual(page_one["citations"]["pagination"]["total_items"], 25)
        self.assertTrue(page_one["citations"]["pagination"]["has_next"])
        self.assertEqual(page_two["citations"]["items"][0]["paper"]["doi"], "10.1000/pagination.11")

    def test_partial_snapshot_is_refreshed_automatically_on_open(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.48550/arxiv.2501.00663")["paper"]
        with self.service._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO paper_relation_snapshots (
                    paper_id, direction, status, items_json, summary_json, source_summary_json,
                    degraded_json, fetched_at, expires_at, updated_at
                ) VALUES (?, 'citations', 'partial', '[]', '{\"count\":0,\"partial\":0,\"incomplete\":0,\"retrieved\":0,\"inferred\":0}', '[{\"provider\":\"openalex\",\"count\":0,\"status\":\"queried\"}]', '[]', '2026-03-21T00:00:00+00:00', '2099-01-01T00:00:00+00:00', '2026-03-21T00:00:00+00:00')
                """,
                (paper["id"],),
            )
            connection.commit()
        live = self.service.get_live_relations(self.user["id"], paper["id"], direction="citations", force_refresh=False)
        self.assertFalse(live["cache_hit"])
        self.assertGreaterEqual(live["citations"]["summary"]["count"], 1)

    def test_graph_edge_state_becomes_retrieved_after_directional_refresh(self) -> None:
        seed = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2021.004")["paper"]
        cited = self.service.get_paper(seed["graph"]["references"][0]["paper"]["id"])
        self.assertEqual(cited["graph"]["citations"][0]["edge"]["state"], "inferred")
        refreshed = self.service.refresh_paper_graph(self.user["id"], cited["id"], mode="citations", force_refresh=True, rebuild=True)
        citation_entry = refreshed["paper"]["graph"]["citations"][0]
        self.assertEqual(citation_entry["paper"]["id"], seed["id"])
        self.assertEqual(citation_entry["edge"]["state"], "retrieved")

    def test_recommendations_reduce_reappearance_of_excluded_papers(self) -> None:
        seed = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2020.001")["paper"]
        candidate = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2021.004")["paper"]
        recommendations = self.service.recommend(self.user["id"], seed_paper_ids=[seed["id"]])["results"]
        self.assertTrue(any(item["paper"]["id"] == candidate["id"] for item in recommendations))
        self.service.set_paper_state(self.user["id"], candidate["id"], {"status": "escluso", "feedback_type": "escluso"})
        filtered = self.service.recommend(self.user["id"], seed_paper_ids=[seed["id"]])["results"]
        self.assertFalse(any(item["paper"]["id"] == candidate["id"] for item in filtered))

    def test_import_preview_and_completion(self) -> None:
        preview = self.service.import_records(
            self.user["id"],
            {"source_type": "identifiers", "content": "10.1000/litdisc.2020.001\n10.1000/litdisc.2024.009", "preview": True},
        )
        self.assertEqual(len(preview["preview"]), 2)
        result = self.service.import_records(
            self.user["id"],
            {"source_type": "identifiers", "content": "10.1000/litdisc.2020.001\n10.1000/litdisc.2024.009"},
        )
        self.assertEqual(result["summary"]["success"], 2)

    def test_collection_sharing_and_export(self) -> None:
        collection = self.service.create_collection(self.user["id"], "Shared Reading")
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2023.008", collection_id=collection["id"])["paper"]
        self.service.add_note(self.user["id"], {"target_type": "collection", "target_id": collection["id"], "body": "Shared note", "visibility": "shared", "collection_id": collection["id"]})
        invite = self.service.invite_collaborator(self.user["id"], collection["id"], self.other["email"], "editor")
        self.assertEqual(invite["role"], "editor")
        exported = self.service.export_collection(self.user["id"], collection["id"], export_format="json")
        payload = json.loads(exported["content"])
        self.assertEqual(payload["collection"]["id"], collection["id"])
        self.assertEqual(payload["papers"][0]["id"], paper["id"])

    def test_provider_lookup_and_relations_are_cached(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2020.001")["paper"]
        first_call_count = sum(self.transport.calls.values())
        refreshed = self.service.refresh_paper_graph(self.user["id"], paper["id"], force_refresh=False)
        second_call_count = sum(self.transport.calls.values())
        self.assertTrue(refreshed["cache_hit"])
        self.assertEqual(first_call_count, second_call_count)

    def test_retrieval_runs_are_listed(self) -> None:
        paper = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2020.001")["paper"]
        self.service.refresh_paper_graph(self.user["id"], paper["id"], force_refresh=True)
        runs = self.service.list_retrieval_runs(self.user["id"], paper_id=paper["id"])
        self.assertGreaterEqual(len(runs), 2)
        self.assertTrue(any(run["operation"] == "graph_refresh" for run in runs))

    def test_collection_graph_refresh_refreshes_saved_papers(self) -> None:
        collection = self.service.create_collection(self.user["id"], "Seed Graph")
        first = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2020.001", collection_id=collection["id"])["paper"]
        second = self.service.add_paper(self.user["id"], identifier_type="doi", value="10.1000/litdisc.2021.004", collection_id=collection["id"])["paper"]
        refreshed = self.service.refresh_collection_graph(self.user["id"], collection["id"], mode="all", force_refresh=True, rebuild=True)
        self.assertEqual(refreshed["stats"]["refreshed_papers"], 2)
        collection_papers = {paper["id"] for paper in refreshed["collection"]["papers"]}
        self.assertEqual(collection_papers, {first["id"], second["id"]})


if __name__ == "__main__":
    unittest.main()
