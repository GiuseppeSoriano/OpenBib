"""Tests for canonical key construction."""

from app.common.canonical import build_canonical_key


def test_doi_based_key():
    key = build_canonical_key(doi="10.1234/test.5678")
    assert key == "doi:10.1234/test.5678"


def test_doi_strips_url_prefix():
    key = build_canonical_key(doi="https://doi.org/10.1234/Test")
    assert key == "doi:10.1234/test"


def test_doi_lowercased():
    key = build_canonical_key(doi="10.1234/UPPER.CASE")
    assert key == "doi:10.1234/upper.case"


def test_hash_based_key_with_all_fields():
    key = build_canonical_key(
        doi=None,
        title="Attention Is All You Need",
        authors=["Ashish Vaswani", "Noam Shazeer"],
        year=2017,
    )
    assert key.startswith("hash:")
    assert len(key) == len("hash:") + 16


def test_hash_key_stable():
    k1 = build_canonical_key(doi=None, title="Test", authors=["Alice"], year=2024)
    k2 = build_canonical_key(doi=None, title="Test", authors=["Alice"], year=2024)
    assert k1 == k2


def test_hash_key_different_for_different_inputs():
    k1 = build_canonical_key(doi=None, title="Paper A")
    k2 = build_canonical_key(doi=None, title="Paper B")
    assert k1 != k2
