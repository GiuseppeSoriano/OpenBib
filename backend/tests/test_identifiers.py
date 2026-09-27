"""Identifier normalization at the API boundary (mirrored in the frontend)."""

import hashlib

import pytest

from app.common.exceptions import InvalidIdentifierError
from app.common.identifiers import (
    normalize_doi,
    normalize_paper_key,
    parse_paper_identifier,
    strip_doi_prefixes,
    synthetic_group_key,
)

TNN = "10.1109/tnn.2008.2005605"

VALID = [
    ("10.1109/tnn.2008.2005605", TNN),
    ("doi:10.1109/tnn.2008.2005605", TNN),
    ("DOI: 10.1109/TNN.2008.2005605", TNN),
    ("DOI 10.1109/tnn.2008.2005605", TNN),
    ("https://doi.org/10.1109/tnn.2008.2005605", TNN),
    ("http://dx.doi.org/10.1109/tnn.2008.2005605", TNN),
    ("https://dx.doi.org/10.1109/tnn.2008.2005605", TNN),
    ("https://www.doi.org/10.1109/tnn.2008.2005605", TNN),
    ("doi.org/10.1109/tnn.2008.2005605", TNN),
    ("10.1109/TNN.2008.2005605", TNN),
    ("  10.1109/tnn.2008.2005605\n", TNN),
    ("\u00a010.1109/tnn.2008.2005605\u00a0", TNN),
    ("\u200b10.1109/tnn.2008.2005605\ufeff", TNN),
    ("https://doi.org/10.1109%2Ftnn.2008.2005605", TNN),
    ("https%3A%2F%2Fdoi.org%2F10.1109%2Ftnn.2008.2005605", TNN),
    ("doi:doi:10.1109/tnn.2008.2005605", TNN),
    (
        "10.1002/(SICI)1097-4636(199812)43:4<359::AID-JBM1>3.0.CO;2-H",
        "10.1002/(sici)1097-4636(199812)43:4<359::aid-jbm1>3.0.co;2-h",
    ),
    ("https://doi.org/10.1000/end.", "10.1000/end."),
    ("10.1/x", "10.1/x"),
]

INVALID = ["not-a-doi", "10.1/", "", "   ", "http://example.com/x", "group:abc", "doi:", "10.x/y"]


@pytest.mark.parametrize(("raw", "doi"), VALID)
def test_valid_inputs_normalize_to_one_doi(raw, doi):
    assert normalize_doi(raw) == doi
    assert normalize_paper_key(raw) == f"doi:{doi}"
    parsed = parse_paper_identifier(raw)
    assert parsed.kind == "doi"
    assert parsed.doi == doi
    assert parsed.canonical_key == f"doi:{doi}"
    assert parsed.raw == raw


@pytest.mark.parametrize("raw", INVALID)
def test_invalid_inputs_are_rejected_with_a_coded_error(raw):
    assert normalize_doi(raw) is None
    with pytest.raises(InvalidIdentifierError) as exc_info:
        parse_paper_identifier(raw)
    assert exc_info.value.status_code == 422
    assert exc_info.value.detail["code"] == "invalid_identifier"
    assert exc_info.value.detail["value"] == raw


def test_invalid_value_is_truncated_in_the_error():
    with pytest.raises(InvalidIdentifierError) as exc_info:
        parse_paper_identifier("x" * 600)
    assert exc_info.value.detail["value"] == "x" * 200


def test_hash_keys_are_accepted_as_is_and_other_keys_pass_through():
    parsed = parse_paper_identifier(" hash:collpub ")
    assert (parsed.kind, parsed.canonical_key, parsed.doi) == ("hash", "hash:collpub", None)
    assert normalize_paper_key("hash:ABC") == "hash:ABC"
    assert normalize_paper_key(" group:abc ") == "group:abc"
    assert normalize_paper_key("not-a-doi") == "not-a-doi"
    assert normalize_paper_key("doi:not-a-doi") == "doi:not-a-doi"


@pytest.mark.parametrize("raw", [raw for raw, _ in VALID] + INVALID + ["hash:x", "group:y"])
def test_normalize_paper_key_is_idempotent(raw):
    once = normalize_paper_key(raw)
    assert normalize_paper_key(once) == once


def test_percent_encoding_is_only_decoded_in_urls():
    # A doi: key may legitimately contain "%2F"; only URL forms are decoded.
    assert normalize_paper_key("doi:10.1000/a%2Fb") == "doi:10.1000/a%2fb"
    assert strip_doi_prefixes("https://doi.org/10.1000/a%2Fb", decode=True) == "10.1000/a/b"
    assert strip_doi_prefixes("https://doi.org/10.1000/a%2Fb") == "10.1000/a%2Fb"
    assert normalize_doi("10.1109%2Ftnn.2008.2005605") is None


def test_synthetic_group_key_formula_is_stable():
    digest = hashlib.sha256(b"doi:10.9/nocache").hexdigest()[:16]
    assert synthetic_group_key("doi:10.9/nocache") == f"group:{digest}"
