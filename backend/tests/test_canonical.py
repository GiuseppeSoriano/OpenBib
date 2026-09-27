"""Tests for canonical and paper-group key construction."""

import pytest

from app.common.canonical import build_canonical_key, build_paper_group_key
from app.providers import crossref, openalex


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


def test_paper_group_key_normalizes_case_punctuation_and_author_order():
    key1 = build_paper_group_key(
        "Attention, Is All You Need!",
        ["Ashish Vaswani", "Noam Shazeer"],
    )
    key2 = build_paper_group_key(
        "attention is all you need",
        ["Noam Shazeer", "Ashish Vaswani"],
    )
    assert key1 == key2


# Snapshot of provider-data keys, captured before the identifier boundary work:
# canonical and group keys for provider data must stay byte-identical.
KEY_SNAPSHOT = [
    ({"doi": "10.1234/test.5678"}, "doi:10.1234/test.5678"),
    ({"doi": "10.1234/UPPER.CASE"}, "doi:10.1234/upper.case"),
    ({"doi": "https://doi.org/10.1234/Test"}, "doi:10.1234/test"),
    ({"doi": "http://doi.org/10.1/x"}, "doi:10.1/x"),
    ({"doi": " 10.1/x "}, "doi:10.1/x"),
    (
        {"doi": "10.1002/(SICI)1097-4636(199812)43:4<359::AID-JBM1>3.0.CO;2-H"},
        "doi:10.1002/(sici)1097-4636(199812)43:4<359::aid-jbm1>3.0.co;2-h",
    ),
    ({"doi": "10.1000/end."}, "doi:10.1000/end."),
    (
        {
            "title": "Attention Is All You Need",
            "authors": ["Ashish Vaswani", "Noam Shazeer"],
            "year": 2017,
        },
        "hash:08fd7a8286ebae1b",
    ),
    (
        {"title": "Attention Is All You Need", "authors": ["Ashish Vaswani", "Noam Shazeer"]},
        "hash:4f138586299929d1",
    ),
    (
        {"title": "Ünïcode — Title!", "authors": ["José  García"], "year": 1999},
        "hash:69971b13bf1a7b4c",
    ),
    ({"title": None, "authors": None}, "hash:23281f6d2fa5fd65"),
]


@pytest.mark.parametrize(("kwargs", "expected"), KEY_SNAPSHOT)
def test_provider_canonical_keys_are_unchanged(kwargs, expected):
    assert build_canonical_key(**kwargs) == expected


def test_provider_group_keys_are_unchanged():
    assert (
        build_paper_group_key("Attention Is All You Need", ["Ashish Vaswani", "Noam Shazeer"])
        == "group:4d47cb7205af8da8"
    )
    assert build_paper_group_key("Ünïcode — Title!", ["José  García"]) == "group:18251a0c509a4a6d"
    assert build_paper_group_key(None, None) == "group:cbe5cfdf7c2118a9"


def test_mapped_provider_records_keep_their_keys():
    work = {
        "id": "https://openalex.org/W1",
        "doi": "https://doi.org/10.1109/TNN.2008.2005605",
        "title": "The Graph Neural Network Model",
        "publication_year": 2009,
        "authorships": [
            {"author": {"display_name": "Franco Scarselli"}},
            {"author": {"display_name": "Marco Gori"}},
        ],
    }
    mapped = openalex._map_work(work)
    assert (mapped.canonical_key, mapped.paper_group_key) == (
        "doi:10.1109/tnn.2008.2005605",
        "group:f49f230f83959d0c",
    )

    no_doi = {
        "id": "https://openalex.org/W2",
        "doi": None,
        "title": "No DOI Work",
        "publication_year": 2020,
        "authorships": [{"author": {"display_name": "Jane Roe"}}],
    }
    mapped = openalex._map_work(no_doi)
    assert (mapped.canonical_key, mapped.paper_group_key) == (
        "hash:f34404aaa8bf2b8a",
        "group:d6d46872bf395b24",
    )

    item = {
        "DOI": "10.1038/NATURE14539",
        "title": ["Deep learning"],
        "author": [{"given": "Yann", "family": "LeCun"}, {"given": "Yoshua", "family": "Bengio"}],
        "published-print": {"date-parts": [[2015, 5, 28]]},
    }
    mapped = crossref._map_work(item)
    assert (mapped.canonical_key, mapped.paper_group_key) == (
        "doi:10.1038/nature14539",
        "group:e2f00f1ff79a9290",
    )


@pytest.mark.parametrize(
    "doi",
    ["doi:10.1/X", "DOI: 10.1/x", "https://dx.doi.org/10.1/X", "doi.org/10.1/x", "doi:doi:10.1/x"],
)
def test_prefixed_dois_now_strip_to_the_bare_doi(doi):
    assert build_canonical_key(doi=doi) == "doi:10.1/x"


def test_canonical_key_never_percent_decodes():
    assert build_canonical_key(doi="https://doi.org/10.1/a%2Fb") == "doi:10.1/a%2fb"
