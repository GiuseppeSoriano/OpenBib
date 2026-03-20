from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from reference_manager.service import ReferenceManagerService


class ReferenceManagerServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tempdir.name) / "test.sqlite3")
        self.service = ReferenceManagerService(self.db_path)
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


if __name__ == "__main__":
    unittest.main()
