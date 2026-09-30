"""Conservative possible-version hints: flagged, never merged."""

from dataclasses import replace
from datetime import date

import pytest

from app.papers.similarity import (
    find_possible_versions,
    is_possible_version,
    surname,
    title_fingerprint,
)
from app.providers.base import Author, PaperMetadata

TITLE = "Graph Neural Networks: A Review of Methods"


def _paper(
    key: str,
    group: str,
    title: str = TITLE,
    authors: tuple[str, ...] = ("Zonghan Wu", "Shirui Pan", "Fengwen Chen"),
    year: int | None = 2020,
    **fields,
) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=key,
        paper_group_key=group,
        title=title,
        authors=[Author(name=name) for name in authors],
        publication_date=date(year, 6, 1) if year else None,
        provider_source="semantic_scholar",
        **fields,
    )


def test_title_fingerprint_ignores_case_punctuation_and_markup():
    assert title_fingerprint("Graph <i>Neural</i> Networks: a REVIEW of methods") == (
        "graph neural networks a review of methods"
    )
    assert title_fingerprint("GRAPH NEURAL-NETWORKS — A Review of Methods!") == (
        title_fingerprint(TITLE)
    )


@pytest.mark.parametrize("title", ["Deep learning", "Attention is everything", "", None])
def test_short_titles_have_no_fingerprint(title):
    assert title_fingerprint(title) is None


@pytest.mark.parametrize("name", ["Wu Z", "Zonghan Wu", "Z. Wu", "Wu, Zonghan", "WU"])
def test_surname_handles_initials_and_comma_forms(name):
    assert surname(Author(name=name)) == "wu"


def test_surname_prefers_the_explicit_family_name():
    assert surname(Author(name="Zonghan Wu", family_name="Wu-Li")) == "wu li"


def test_case_and_markup_variants_are_flagged():
    preprint = _paper("s2:" + "a" * 40, "group:a", semantic_scholar_id="a" * 40)
    article = _paper(
        "doi:10.1/j",
        "group:b",
        title="graph neural networks: a <b>review</b> of methods",
        authors=("Wu Z", "Pan S"),
        year=2021,
        doi="10.1/j",
        semantic_scholar_id="b" * 40,
    )
    assert is_possible_version(preprint, article)
    assert is_possible_version(article, preprint)


def test_year_gap_above_one_is_not_flagged():
    assert not is_possible_version(_paper("s2:a", "g:a"), _paper("s2:b", "g:b", year=2022))
    # An unknown year is no evidence against it.
    assert is_possible_version(_paper("s2:a", "g:a"), _paper("s2:b", "g:b", year=None))


def test_short_titles_are_not_flagged():
    left = _paper("s2:a", "g:a", title="Deep graph learning")
    assert not is_possible_version(left, replace(left, canonical_key="s2:b", paper_group_key="g:b"))


def test_author_overlap_rules():
    base = _paper("s2:a", "g:a", authors=("Ann Lee", "Bo Chen", "Cy Park"))
    # Different first author, but half of all surnames are shared.
    half = _paper("s2:b", "g:b", authors=("Xi Zhou", "Bo Chen", "Cy Park"))
    assert is_possible_version(base, half)
    third = _paper("s2:c", "g:c", authors=("Xi Zhou", "Yu Wang", "Cy Park"))
    assert not is_possible_version(base, third)
    nobody = _paper("s2:d", "g:d", authors=())
    assert not is_possible_version(base, nobody)


def test_records_sharing_an_s2_id_or_doi_are_never_flagged():
    left = _paper("doi:10.1/a", "g:a", doi="10.1/a", semantic_scholar_id="c" * 40)
    same_s2 = _paper("s2:" + "c" * 40, "g:b", semantic_scholar_id="C" * 40)
    same_doi = _paper("doi:10.1/A", "g:c", doi="10.1/A")
    other_doi = _paper("doi:10.2/b", "g:d", doi="10.2/b")
    assert not is_possible_version(left, same_s2)
    assert not is_possible_version(left, same_doi)
    # A preprint DOI and a journal DOI are exactly the case to flag.
    assert is_possible_version(left, other_doi)


def test_find_possible_versions_links_groups_both_ways_in_result_order():
    papers = [
        _paper("s2:a", "g:a"),
        _paper("s2:x", "g:x", title="An unrelated paper about proteins"),
        _paper("s2:a2", "g:a", year=2021),  # same group: already shown as a version
        _paper("s2:b", "g:b", year=2021),
        _paper("s2:c", "g:c", year=2019),
    ]
    links = find_possible_versions(papers)
    # 2019 and 2021 are two years apart: linked through g:a only, not transitively.
    assert links == {"g:a": ["g:b", "g:c"], "g:b": ["g:a"], "g:c": ["g:a"]}
    # Hints never merge or drop records.
    assert [p.canonical_key for p in papers] == ["s2:a", "s2:x", "s2:a2", "s2:b", "s2:c"]


def test_find_possible_versions_is_empty_without_candidates():
    assert find_possible_versions([]) == {}
    assert find_possible_versions([_paper("s2:a", "g:a"), _paper("s2:b", "g:b", year=2010)]) == {}
