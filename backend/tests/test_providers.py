"""Tests for provider response mapping (OpenAlex)."""

from app.providers.openalex import _map_work, _reconstruct_abstract


def test_reconstruct_abstract():
    inverted = {"Hello": [0], "world": [1], "foo": [2]}
    assert _reconstruct_abstract(inverted) == "Hello world foo"


def test_reconstruct_abstract_none():
    assert _reconstruct_abstract(None) is None


def test_map_work_minimal():
    raw = {
        "id": "https://openalex.org/W123",
        "doi": "https://doi.org/10.1234/test",
        "title": "Test Paper",
        "authorships": [
            {
                "author": {"display_name": "Alice Smith", "id": "A1", "orcid": None},
                "institutions": [],
            }
        ],
        "publication_date": "2023-06-15",
        "abstract_inverted_index": {"Hello": [0], "world": [1]},
        "biblio": {"volume": "1", "issue": "2", "first_page": "10", "last_page": "20"},
        "primary_location": {"source": {"display_name": "Nature"}},
        "type": "article",
        "topics": [{"display_name": "AI"}],
        "keywords": [{"keyword": "attention"}],
        "open_access": {"is_oa": True, "oa_url": "https://example.com/paper.pdf"},
        "cited_by_count": 100,
        "referenced_works_count": 30,
    }
    paper = _map_work(raw)
    assert paper.canonical_key == "doi:10.1234/test"
    assert paper.title == "Test Paper"
    assert len(paper.authors) == 1
    assert paper.authors[0].name == "Alice Smith"
    assert paper.abstract == "Hello world"
    assert paper.venue == "Nature"
    assert paper.pages == "10–20"
    assert paper.open_access is True
    assert paper.cited_by_count == 100
    assert paper.provider_source == "openalex"
