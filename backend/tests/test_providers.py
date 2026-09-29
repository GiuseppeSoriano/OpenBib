"""Tests for provider response mapping."""

import xml.etree.ElementTree as ET
from datetime import date

import pytest
import respx
from httpx import Response

from app.common.canonical import build_canonical_key, build_paper_group_key
from app.providers import arxiv, crossref, europepmc
from app.providers.openalex import _map_work, _reconstruct_abstract

MARKUP_TITLE = "Odor <i>coding</i> in <scp>Drosophila</scp>"


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
    assert paper.paper_group_key.startswith("group:")
    assert paper.title == "Test Paper"
    assert len(paper.authors) == 1
    assert paper.authors[0].name == "Alice Smith"
    assert paper.abstract == "Hello world"
    assert paper.venue == "Nature"
    assert paper.pages == "10–20"
    assert paper.open_access is True
    assert paper.cited_by_count == 100
    assert paper.provider_source == "openalex"


def _assert_raw_title_keys(paper, raw_title, authors, doi=None, year=None):
    """Cleaning the stored title never changes the keys built from the raw one."""
    assert paper.canonical_key == build_canonical_key(
        doi=doi, title=raw_title, authors=authors, year=year
    )
    assert paper.paper_group_key == build_paper_group_key(raw_title, authors)


# ── OpenAlex ────────────────────────────────────────────────


def _openalex_work(**overrides) -> dict:
    raw = {
        "id": "https://openalex.org/W9",
        "doi": None,
        "title": MARKUP_TITLE,
        "authorships": [{"author": {"display_name": "Ada Lovelace"}, "institutions": []}],
        "publication_year": 2021,
        "publication_date": "2021-03-04",
        "abstract_inverted_index": {"<p>Hello": [0], "world</p>": [1]},
    }
    raw.update(overrides)
    return raw


def test_openalex_cleans_text_and_keeps_raw_title_keys():
    paper = _map_work(_openalex_work())
    assert paper.title == "Odor coding in Drosophila"
    assert paper.abstract == "Hello world"
    _assert_raw_title_keys(paper, MARKUP_TITLE, ["Ada Lovelace"], year=2021)


def test_openalex_missing_title_stays_none():
    # Graph lookups skip untitled works (``title is not None``) so they never
    # overwrite a titled cached row for the same DOI.
    assert _map_work(_openalex_work(title=None)).title is None


def test_openalex_landing_only_location_is_full_text_not_pdf():
    paper = _map_work(
        _openalex_work(
            open_access={"is_oa": True, "oa_url": "https://repo.example/record/1"},
            best_oa_location={"landing_page_url": "https://repo.example/record/1", "pdf_url": None},
        )
    )
    assert paper.pdf_url is None
    assert paper.abstract_url == "https://repo.example/record/1"


def test_openalex_pdf_from_best_or_open_primary_location():
    paper = _map_work(
        _openalex_work(
            open_access={"is_oa": True, "oa_url": "https://oa.example/a.pdf"},
            best_oa_location={
                "landing_page_url": "https://oa.example/a",
                "pdf_url": "https://oa.example/a.pdf",
            },
        )
    )
    assert paper.pdf_url == "https://oa.example/a.pdf"
    assert paper.abstract_url == "https://oa.example/a"

    closed = _map_work(
        _openalex_work(primary_location={"is_oa": False, "pdf_url": "https://pay.example/a.pdf"})
    )
    assert closed.pdf_url is None
    assert closed.abstract_url is None

    open_primary = _map_work(
        _openalex_work(primary_location={"is_oa": True, "pdf_url": "https://oa.example/b.pdf"})
    )
    assert open_primary.pdf_url == "https://oa.example/b.pdf"


# ── Crossref ────────────────────────────────────────────────

CC_BY = [{"URL": "http://creativecommons.org/licenses/by/4.0/"}]


def _crossref_work(**overrides) -> dict:
    raw = {
        "DOI": "10.20944/preprints202101.0019.v2",
        "type": "posted-content",
        "subtype": "preprint",
        "title": [MARKUP_TITLE],
        "author": [{"given": "Ada", "family": "Lovelace"}],
        "posted": {"date-parts": [[2021, 1, 4]]},
        "issued": {"date-parts": [[2021, 1]]},
        "institution": [{"name": "Preprints.org"}],
        "group-title": "Biology",
        "abstract": (
            "<jats:title>Abstract</jats:title><jats:sec><jats:title>Background</jats:title>"
            "<jats:p>Odor p &lt; 0.05</jats:p></jats:sec>"
        ),
    }
    raw.update(overrides)
    return raw


def test_crossref_posted_content_gets_version_date_and_server():
    paper = crossref._map_work(_crossref_work())
    assert paper.version == "v2"
    assert paper.publication_date == date(2021, 1, 4)
    assert paper.venue == "Preprints.org"
    assert paper.title == "Odor coding in Drosophila"
    assert paper.abstract == "Background: Odor p < 0.05"
    _assert_raw_title_keys(
        paper, MARKUP_TITLE, ["Ada Lovelace"], doi="10.20944/preprints202101.0019.v2"
    )


@pytest.mark.parametrize(
    ("doi", "version"),
    [
        ("10.21203/rs.3.rs-123/v3", "v3"),
        ("10.36227/techrxiv.12345.v10", "v10"),
        ("10.1101/2021.01.01.425000", None),
    ],
)
def test_crossref_preprint_version_from_doi_suffix(doi, version):
    assert crossref._map_work(_crossref_work(DOI=doi)).version == version


def test_crossref_journal_doi_ending_in_v1_is_not_a_version():
    paper = crossref._map_work(
        _crossref_work(
            DOI="10.1234/jour.v1",
            type="journal-article",
            subtype=None,
            **{"container-title": ["Journal of Tests"]},
        )
    )
    assert paper.version is None
    assert paper.venue == "Journal of Tests"


def test_crossref_venue_falls_back_to_group_title_and_issued_date():
    paper = crossref._map_work(_crossref_work(institution=[], posted=None))
    assert paper.venue == "Biology"
    assert paper.publication_date == date(2021, 1, 1)


def test_crossref_date_prefers_print_then_online():
    paper = crossref._map_work(
        _crossref_work(
            **{
                "published-online": {"date-parts": [[2020, 5, 6]]},
                "published-print": {"date-parts": [[2020, 7, 1]]},
            }
        )
    )
    assert paper.publication_date == date(2020, 7, 1)


def test_crossref_hash_key_year_unchanged_by_posted_date():
    raw = _crossref_work(DOI=None)
    paper = crossref._map_work(raw)
    assert paper.publication_date == date(2021, 1, 4)
    _assert_raw_title_keys(paper, MARKUP_TITLE, ["Ada Lovelace"], year=None)


def _pdf_link(**overrides) -> dict:
    link = {
        "URL": "https://pub.example/a.pdf",
        "content-type": "application/pdf",
        "intended-application": "similarity-checking",
    }
    link.update(overrides)
    return link


def test_crossref_pdf_only_when_open_and_meant_for_readers():
    ok = crossref._map_work(_crossref_work(license=CC_BY, link=[_pdf_link()]))
    assert ok.pdf_url == "https://pub.example/a.pdf"

    mining = _pdf_link(**{"intended-application": "text-mining"})
    assert crossref._map_work(_crossref_work(license=CC_BY, link=[mining])).pdf_url is None
    unlicensed = [{"URL": "https://www.elsevier.com/tdm/userlicense/1.0/"}]
    assert (
        crossref._map_work(_crossref_work(license=unlicensed, link=[_pdf_link()])).pdf_url is None
    )
    assert crossref._map_work(_crossref_work(link=[_pdf_link()])).pdf_url is None
    xml = _pdf_link(**{"content-type": "text/xml"})
    assert crossref._map_work(_crossref_work(license=CC_BY, link=[xml])).pdf_url is None


@pytest.mark.asyncio
@respx.mock
async def test_crossref_lookup_maps_posted_content():
    respx.get(url__regex=r"https://api\.crossref\.org/works/10\.21203/rs\.3\.rs-1/v2").mock(
        return_value=Response(200, json={"message": _crossref_work(DOI="10.21203/rs.3.rs-1/v2")})
    )
    paper = await crossref.CrossrefProvider().lookup_by_doi("10.21203/rs.3.rs-1/v2")
    assert paper is not None
    assert paper.version == "v2"
    assert paper.canonical_key == "doi:10.21203/rs.3.rs-1/v2"


# ── Europe PMC ──────────────────────────────────────────────


def _europepmc_result(full_text_urls: list[dict]) -> dict:
    return {
        "id": "123",
        "pmid": "123",
        "title": MARKUP_TITLE,
        "authorString": "Lovelace A, Byron G.",
        "firstPublicationDate": "2022-02-03",
        "abstractText": "<h4>Background</h4>Odor &amp; taste.<h4>Results</h4>It works.",
        "fullTextUrlList": {"fullTextUrl": full_text_urls},
    }


def test_europepmc_cleans_text_and_keeps_raw_title_keys():
    paper = europepmc._map_result(_europepmc_result([]))
    assert paper.title == "Odor coding in Drosophila"
    assert paper.abstract == "Background: Odor & taste.\n\nResults: It works."
    _assert_raw_title_keys(paper, MARKUP_TITLE, ["Lovelace A", "Byron G."], year=2022)


def test_europepmc_full_text_link_only_when_readable():
    subscription = {"availabilityCode": "S", "documentStyle": "html", "url": "https://pay/1"}
    free = {"availabilityCode": "F", "documentStyle": "html", "url": "https://free/1"}
    oa_pdf = {"availabilityCode": "OA", "documentStyle": "pdf", "url": "https://oa/1.pdf"}

    paper = europepmc._map_result(_europepmc_result([subscription]))
    assert paper.abstract_url is None
    paper = europepmc._map_result(_europepmc_result([subscription, free, oa_pdf]))
    assert paper.abstract_url == "https://free/1"
    assert paper.pdf_url == "https://oa/1.pdf"


# ── arXiv ───────────────────────────────────────────────────

_ARXIV_ENTRY = """<entry xmlns="http://www.w3.org/2005/Atom"
    xmlns:arxiv="http://arxiv.org/schemas/atom">
  <id>http://arxiv.org/abs/2301.12345v2</id>
  <title>Graph   neural
    networks with &lt;i&gt;style&lt;/i&gt;</title>
  <summary>  We study graph
  networks in depth.

  A second paragraph.
  </summary>
  <author><name>Ada Lovelace</name></author>
  <published>2023-01-29T00:00:00Z</published>
</entry>"""


def test_arxiv_normalizes_summary_and_keeps_raw_title_keys():
    paper = arxiv._parse_entry(ET.fromstring(_ARXIV_ENTRY))
    raw_title = "Graph neural networks with <i>style</i>"
    assert paper.title == "Graph neural networks with style"
    assert paper.abstract == "We study graph networks in depth.\n\nA second paragraph."
    assert paper.version == "v2"
    _assert_raw_title_keys(paper, raw_title, ["Ada Lovelace"], year=2023)
