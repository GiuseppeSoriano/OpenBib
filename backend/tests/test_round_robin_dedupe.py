"""Tests for round_robin_dedupe — parallel-search merge + cross-provider dedup."""

from datetime import date

from app.providers.base import Author, PaperMetadata, SearchResult
from app.papers.service import round_robin_dedupe


def _paper(
    canonical_key: str,
    paper_group_key: str,
    title: str,
    provider_source: str,
    publication_date: date | None = None,
    version: str | None = None,
) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=canonical_key,
        paper_group_key=paper_group_key,
        title=title,
        authors=[Author(name="Alice Smith")],
        publication_date=publication_date,
        version=version,
        provider_source=provider_source,
    )


def _result(provider: str, papers: list[PaperMetadata]) -> SearchResult:
    return SearchResult(
        papers=papers,
        total_count=len(papers),
        page=1,
        page_size=20,
        provider=provider,
    )


def test_empty_input_returns_empty_result():
    merged = round_robin_dedupe([])

    assert merged.papers == []
    assert merged.total_count == 0
    assert merged.providers == []
    assert merged.provider == ""


def test_single_provider_passthrough_with_provider_sources_initialised():
    papers = [
        _paper("doi:10.1/a", "group:a", "A", provider_source="openalex"),
        _paper("doi:10.1/b", "group:b", "B", provider_source="openalex"),
    ]
    merged = round_robin_dedupe([_result("openalex", papers)])

    assert [p.canonical_key for p in merged.papers] == ["doi:10.1/a", "doi:10.1/b"]
    for p in merged.papers:
        assert p.provider_sources == ["openalex"]
    assert merged.providers == ["openalex"]
    assert merged.provider == "openalex"
    assert merged.total_count == 2


def test_round_robin_interleaves_two_providers():
    oa = [
        _paper("doi:10.1/oa1", "group:oa1", "OA-1", provider_source="openalex"),
        _paper("doi:10.1/oa2", "group:oa2", "OA-2", provider_source="openalex"),
        _paper("doi:10.1/oa3", "group:oa3", "OA-3", provider_source="openalex"),
    ]
    cr = [
        _paper("doi:10.1/cr1", "group:cr1", "CR-1", provider_source="crossref"),
        _paper("doi:10.1/cr2", "group:cr2", "CR-2", provider_source="crossref"),
    ]
    merged = round_robin_dedupe([_result("openalex", oa), _result("crossref", cr)])

    assert [p.canonical_key for p in merged.papers] == [
        "doi:10.1/oa1",
        "doi:10.1/cr1",
        "doi:10.1/oa2",
        "doi:10.1/cr2",
        "doi:10.1/oa3",
    ]
    assert merged.providers == ["openalex", "crossref"]


def test_duplicate_canonical_key_is_kept_at_earliest_position_and_unions_sources():
    # Same DOI appears in both providers; OpenAlex's slot is rank 2, Crossref's
    # is rank 5 in its own list. After round-robin, OpenAlex's "P" slot lands
    # at merged-index 2 (OA[1], CR[1], OA[2]=P), and Crossref's later occurrence
    # is dropped. provider_sources is the union.
    shared_doi = "doi:10.1/shared"
    oa = [
        _paper("doi:10.1/oa1", "group:oa1", "OA-1", provider_source="openalex"),
        _paper(shared_doi, "group:shared", "Shared P", provider_source="openalex"),
        _paper("doi:10.1/oa3", "group:oa3", "OA-3", provider_source="openalex"),
    ]
    cr = [
        _paper("doi:10.1/cr1", "group:cr1", "CR-1", provider_source="crossref"),
        _paper("doi:10.1/cr2", "group:cr2", "CR-2", provider_source="crossref"),
        _paper("doi:10.1/cr3", "group:cr3", "CR-3", provider_source="crossref"),
        _paper("doi:10.1/cr4", "group:cr4", "CR-4", provider_source="crossref"),
        _paper(shared_doi, "group:shared", "Shared P", provider_source="crossref"),
    ]
    merged = round_robin_dedupe([_result("openalex", oa), _result("crossref", cr)])

    keys = [p.canonical_key for p in merged.papers]
    # P appears once, at the OA-rank-2 slot (3rd position in merged output).
    assert keys.count(shared_doi) == 1
    assert keys[2] == shared_doi

    # The CR rank-5 slot is dropped; CR4 is the last CR contribution.
    assert keys[-1] == "doi:10.1/cr4"

    shared = next(p for p in merged.papers if p.canonical_key == shared_doi)
    assert shared.provider_sources == ["crossref", "openalex"]


def test_already_aggregated_provider_sources_are_unioned_not_overwritten():
    """If a paper already has provider_sources from a previous merge,
    a duplicate occurrence must extend (not replace) the list."""
    p1 = _paper("doi:10.1/x", "group:x", "X", provider_source="openalex")
    p1.provider_sources = ["openalex", "europepmc"]
    p2 = _paper("doi:10.1/x", "group:x", "X", provider_source="crossref")

    merged = round_robin_dedupe(
        [_result("openalex", [p1]), _result("crossref", [p2])]
    )

    assert len(merged.papers) == 1
    assert merged.papers[0].provider_sources == ["crossref", "europepmc", "openalex"]


def test_zip_longest_handles_unequal_stream_lengths():
    short = [_paper("doi:1/s1", "group:s1", "S1", provider_source="arxiv")]
    long = [
        _paper("doi:1/l1", "group:l1", "L1", provider_source="openalex"),
        _paper("doi:1/l2", "group:l2", "L2", provider_source="openalex"),
        _paper("doi:1/l3", "group:l3", "L3", provider_source="openalex"),
    ]
    merged = round_robin_dedupe(
        [_result("openalex", long), _result("arxiv", short)]
    )

    assert [p.canonical_key for p in merged.papers] == [
        "doi:1/l1",
        "doi:1/s1",
        "doi:1/l2",
        "doi:1/l3",
    ]


def test_total_count_is_sum_of_papers_received():
    oa = [_paper(f"doi:1/oa{i}", f"group:oa{i}", f"OA-{i}", "openalex") for i in range(3)]
    cr = [_paper(f"doi:1/cr{i}", f"group:cr{i}", f"CR-{i}", "crossref") for i in range(2)]

    merged = round_robin_dedupe([_result("openalex", oa), _result("crossref", cr)])

    # raw rows received before dedup; the router uses this as raw_total_count.
    assert merged.total_count == 5


def test_provider_string_is_plus_joined_for_backwards_compat():
    oa = [_paper("doi:1/a", "group:a", "A", "openalex")]
    cr = [_paper("doi:1/b", "group:b", "B", "crossref")]
    ax = [_paper("doi:1/c", "group:c", "C", "arxiv")]

    merged = round_robin_dedupe(
        [_result("openalex", oa), _result("crossref", cr), _result("arxiv", ax)]
    )

    assert merged.provider == "openalex+crossref+arxiv"
    assert merged.providers == ["openalex", "crossref", "arxiv"]
