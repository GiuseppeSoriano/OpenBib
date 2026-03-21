from __future__ import annotations

import json
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
    cited_by_filter: str,
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
        "cited_by_api_url": f"https://api.openalex.org/works?filter=cites:{cited_by_filter}",
        "topics": [{"display_name": "literature discovery"}],
        "keywords": [{"display_name": "citation graph"}],
        "concepts": [{"display_name": "academic search"}],
        "abstract_inverted_index": {"Visual": [0], "scholarly": [1], "discovery": [2]},
        "cited_by_count": 3,
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
}


class MockTransport:
    def __init__(self) -> None:
        self.calls: dict[str, int] = {}

    def get_json(self, url: str, *, headers=None, timeout: int = 20) -> dict:
        self.calls[url] = self.calls.get(url, 0) + 1
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Flitdisc.2020.001" in url:
            return OPENALEX_FIXTURES["W1001"]
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Flitdisc.2021.004" in url:
            return OPENALEX_FIXTURES["W1004"]
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Flitdisc.2023.008" in url:
            return OPENALEX_FIXTURES["W1008"]
        if "api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1000%2Flitdisc.2024.009" in url:
            return OPENALEX_FIXTURES["W1009"]
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
        if "filter=cites%3AW1001" in url or "filter=cites:W1001" in url:
            return {"meta": {"count": 1}, "results": [OPENALEX_FIXTURES["W1004"]]}
        if "filter=cites%3AW1004" in url or "filter=cites:W1004" in url:
            return {"meta": {"count": 0}, "results": []}
        if "filter=cites%3AW1008" in url or "filter=cites:W1008" in url:
            return {"meta": {"count": 0}, "results": []}
        if "filter=cites%3AW1009" in url or "filter=cites:W1009" in url:
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
        if "europepmc" in url:
            return {"resultList": {"result": []}}
        raise AssertionError(f"Unexpected URL requested in test: {url}")


class ReferenceManagerServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tempdir.name) / "test.sqlite3")
        self.config = AppConfig(
            openalex_api_key="test-openalex-key",
            crossref_mailto="tests@example.com",
            europepmc_enabled=True,
            europepmc_email="tests@example.com",
            request_timeout_seconds=5,
            max_related_works=25,
            provider_cache_ttl_seconds=3600,
            search_cache_ttl_seconds=1800,
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
        self.assertTrue(any(source["provider"] == "openalex" for source in paper["sources"]))
        self.assertIsNotNone(paper["retrieval"])

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


if __name__ == "__main__":
    unittest.main()
