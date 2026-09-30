"""Identifier normalization at the API boundary (mirrored in the frontend)."""

import hashlib

import pytest

from app.common.exceptions import InvalidIdentifierError
from app.common.identifiers import (
    normalize_doi,
    normalize_paper_key,
    parse_lookup_key,
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


S2_ID = "3efd851140aa28e95221b55fcc5659eea97b172d"
STRONG = [
    (f"s2:{S2_ID}", "s2", f"s2:{S2_ID}"),
    (f" S2:{S2_ID.upper()} ", "s2", f"s2:{S2_ID}"),
    (f"https://www.semanticscholar.org/paper/{S2_ID}", "s2", f"s2:{S2_ID}"),
    (
        f"https://www.semanticscholar.org/paper/The-Graph-Neural-Network-Model/{S2_ID.upper()}",
        "s2",
        f"s2:{S2_ID}",
    ),
    (f"semanticscholar.org/paper/{S2_ID}/", "s2", f"s2:{S2_ID}"),
    ("arxiv:2501.00663", "arxiv", "arxiv:2501.00663"),
    ("arXiv:2501.00663v2", "arxiv", "arxiv:2501.00663"),
    ("2501.00663", "arxiv", "arxiv:2501.00663"),
    ("0704.0001v1", "arxiv", "arxiv:0704.0001"),
    ("https://arxiv.org/abs/2501.00663v3", "arxiv", "arxiv:2501.00663"),
    ("http://arxiv.org/pdf/2501.00663v1.pdf", "arxiv", "arxiv:2501.00663"),
    ("arxiv.org/abs/2501.00663", "arxiv", "arxiv:2501.00663"),
    ("arXiv:hep-th/9901001v2", "arxiv", "arxiv:hep-th/9901001"),
    ("https://arxiv.org/abs/math.GT/0309136", "arxiv", "arxiv:math.gt/0309136"),
    ("pmid:31452104", "pmid", "pmid:31452104"),
    ("PMID: 31452104", "pmid", "pmid:31452104"),
    ("pmcid:PMC2323736", "pmcid", "pmcid:PMC2323736"),
    ("PMCID:pmc2323736", "pmcid", "pmcid:PMC2323736"),
]
STRONG_INVALID = [
    "s2:" + "a" * 39,
    "s2:" + "g" * 40,
    S2_ID,
    "https://www.semanticscholar.org/author/123",
    "arxiv:not-an-id",
    "250.00663",
    "https://arxiv.org/list/cs.LG/recent",
    "pmid:abc",
    "pmcid:2323736",
    "PMC2323736",
]


@pytest.mark.parametrize(("raw", "kind", "key"), STRONG)
def test_strong_identifiers_parse_to_their_lookup_keys(raw, kind, key):
    parsed = parse_paper_identifier(raw)
    assert (parsed.kind, parsed.canonical_key, parsed.doi, parsed.raw) == (kind, key, None, raw)
    assert parsed.lookup_id == key
    assert parse_lookup_key(key) == parse_paper_identifier(key)


@pytest.mark.parametrize("raw", STRONG_INVALID)
def test_malformed_strong_identifiers_are_invalid(raw):
    with pytest.raises(InvalidIdentifierError):
        parse_paper_identifier(raw)


def test_lookup_ids_and_lookup_keys():
    assert parse_paper_identifier("10.1/x").lookup_id == "doi:10.1/x"
    assert parse_paper_identifier("hash:abc").lookup_id is None
    assert parse_lookup_key("doi:10.1/x").doi == "10.1/x"
    assert parse_lookup_key("hash:abc") is None
    assert parse_lookup_key("group:abc") is None
    assert parse_lookup_key("doi:not-a-doi") is None


def test_strong_keys_pass_through_normalization():
    # Lenient paths never mangle strong keys; only the S2 paperId is lowercased.
    assert normalize_paper_key(f"s2:{S2_ID.upper()}") == f"s2:{S2_ID}"
    assert normalize_paper_key(f"S2:{S2_ID}") == f"s2:{S2_ID}"
    assert normalize_paper_key("arxiv:2501.00663v2") == "arxiv:2501.00663v2"
    assert normalize_paper_key("ARXIV:2501.00663") == "arxiv:2501.00663"
    assert normalize_paper_key(" pmid:31452104 ") == "pmid:31452104"
    assert normalize_paper_key("pmcid:PMC2323736") == "pmcid:PMC2323736"
    # PMCIDs are stored as ``PMC<digits>``, whatever case the client sends.
    assert normalize_paper_key("PMCID:pmc2323736") == "pmcid:PMC2323736"
    assert normalize_paper_key("openalex:W123") == "openalex:W123"
    for _raw, _kind, key in STRONG:
        assert normalize_paper_key(key) == key
