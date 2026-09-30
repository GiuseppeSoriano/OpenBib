"""Tests for provider text normalization (app.common.text)."""

import pytest

from app.collections.schemas import ImportLineResult
from app.common.text import clean_inline_text, normalize_abstract
from app.graph.schemas import GraphNode
from app.papers.schemas import PaperMetadataRead, SearchPaperGroupItemRead


def test_europepmc_headings_become_prefixed_paragraphs():
    raw = "<h4>Background</h4>A study.<h4>Results</h4>B holds."
    assert normalize_abstract(raw) == "Background: A study.\n\nResults: B holds."


def test_jats_sections_drop_leading_abstract_heading():
    raw = (
        "<jats:title>Abstract</jats:title>"
        "<jats:sec><jats:title>Background</jats:title>"
        "<jats:p>Odor <jats:italic>coding</jats:italic> matters.</jats:p></jats:sec>"
        "<jats:sec><jats:title>Methods:</jats:title><jats:p>We measured.</jats:p></jats:sec>"
    )
    assert normalize_abstract(raw) == ("Background: Odor coding matters.\n\nMethods: We measured.")


def test_block_tags_split_paragraphs_and_inline_tags_unwrap():
    raw = "<p>First <b>bold</b> part.</p><p>Second<br/>third</p>"
    assert normalize_abstract(raw) == "First bold part.\n\nSecond\n\nthird"


def test_entities_are_decoded():
    assert normalize_abstract("Smith &amp; Jones &lt;3 &#233;t&eacute;") == "Smith & Jones <3 été"


def test_literal_comparisons_survive():
    assert normalize_abstract("Effect p < 0.05 and q > 1.") == "Effect p < 0.05 and q > 1."
    assert normalize_abstract("<p>p<0.05, x>1</p>") == "p<0.05, x>1"
    assert clean_inline_text("A <b> tag and p<q") == "A tag and p<q"
    # Free text after a tag-like name is not an attribute list.
    assert normalize_abstract("if x<a and y>b then z") == "if x<a and y>b then z"
    assert normalize_abstract("n<p and m>q") == "n<p and m>q"
    assert normalize_abstract("<jats:p>n&lt;a and b&gt;c</jats:p>") == "n<a and b>c"


def test_unknown_tag_like_text_is_kept():
    assert normalize_abstract("Use the <foo> element and <bar:baz>.") == (
        "Use the <foo> element and <bar:baz>."
    )


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("<p>Unclosed <i>italic", "Unclosed italic"),
        ("<p>Nested <b><i>deep</i></b> text</p>", "Nested deep text"),
        ("Safe<script>alert('x')</script> text", "Safe text"),
        ("Safe<style>p { color: red }</style> text", "Safe text"),
        ("Tail <script>never closed", "Tail <script>never closed"),
        (
            "The <style> element comes first. Then scripts.",
            "The <style> element comes first. Then scripts.",
        ),
        ("&lt;script&gt;alert(1)&lt;/script&gt;Kept", "Kept"),
        ("<!-- comment -->Visible", "Visible"),
        ("<table><tr><th>n</th><td>1</td></tr><tr><td>2</td></tr></table>", "n 1\n\n2"),
        ("<table><tr><td>1</td><td>2</td></tr></table>", "1 2"),
        (
            "<table><caption>Doses</caption><thead><tr><th>mg</th></tr></thead>"
            "<tbody><tr><td>5</td></tr></tbody><tfoot><tr><td>n=3</td></tr></tfoot></table>",
            "Doses\n\nmg\n\n5\n\nn=3",
        ),
        ("when x<a and y>b holds", "when x<a and y>b holds"),
        ("x <style>a</style> y <style> z", "x y <style> z"),
    ],
)
def test_malformed_input(raw, expected):
    assert normalize_abstract(raw) == expected


def test_mathml_annotation_is_dropped_and_sup_marked():
    raw = (
        "Energy <mml:math><mml:semantics><mml:mi>E</mml:mi>"
        "<mml:annotation encoding='TeX'>E</mml:annotation></mml:semantics></mml:math>"
        " at 10<sup>-3</sup> and H<sub>2</sub>O."
    )
    assert normalize_abstract(raw) == "Energy E at 10^-3 and H2O."


@pytest.mark.parametrize(
    "raw",
    [
        "<h4>Background</h4>A<h4>Results</h4>B",
        "<jats:title>Abstract</jats:title><jats:p>p &lt; 0.05 &amp; more</jats:p>",
        "Line one\nwraps here.\n\nSecond paragraph.",
        "&amp;lt;i&amp;gt;double&amp;lt;/i&amp;gt; escaped",
        "Plain text p < 0.05",
    ],
)
def test_normalization_is_idempotent(raw):
    once = normalize_abstract(raw)
    assert normalize_abstract(once) == once
    title = clean_inline_text(raw)
    assert clean_inline_text(title) == title


def test_none_and_empty():
    assert normalize_abstract(None) is None
    assert normalize_abstract("") is None
    assert normalize_abstract("  <p> </p> ") is None
    assert clean_inline_text(None) == ""
    assert clean_inline_text("") == ""


def test_arxiv_soft_wraps_collapse():
    raw = "  We study\n  graph networks\nin depth.\n\n  A second\nparagraph.  "
    assert normalize_abstract(raw) == "We study graph networks in depth.\n\nA second paragraph."


def test_inline_title_cleanup():
    assert clean_inline_text("<i>Drosophila</i> olfaction") == "Drosophila olfaction"
    assert clean_inline_text("A <scp>new</scp>\n  method") == "A new method"
    assert clean_inline_text("<jats:title>Heading</jats:title>Rest") == "Heading Rest"
    assert clean_inline_text("Abstract") == "Abstract"
    assert clean_inline_text("XSS: detecting &lt;script&gt; payloads") == (
        "XSS: detecting <script> payloads"
    )


def test_length_is_bounded():
    words = " ".join(["word"] * 10_000)
    abstract = normalize_abstract(words, max_len=1000)
    assert abstract is not None
    assert len(abstract) <= 1000
    assert abstract.endswith("…")
    assert normalize_abstract(abstract, max_len=1000) == abstract
    assert len(clean_inline_text("<i>" + words + "</i>", max_len=200)) <= 200


def test_read_schemas_clean_titles_and_abstracts():
    paper = PaperMetadataRead(
        canonical_key="doi:10.1/x",
        paper_group_key="group:x",
        title="<i>Drosophila</i> olfaction",
        abstract="<h4>Background</h4>A<h4>Results</h4>B",
    )
    assert paper.title == "Drosophila olfaction"
    assert paper.abstract == "Background: A\n\nResults: B"
    assert PaperMetadataRead(canonical_key="k", paper_group_key="g", title="T").abstract is None

    group = SearchPaperGroupItemRead(
        kind="paper_group",
        paper_group_key="group:x",
        title="A <b>group</b>",
        version_count=1,
        selected_version=paper,
    )
    assert group.title == "A group"
    node = GraphNode(id="n", label="<i>Label</i>", paper_group_key="g", selected_version=paper)
    assert node.label == "Label"
    assert GraphNode(id="n", paper_group_key="g", selected_version=paper).label is None
    line = ImportLineResult(line=1, input="10.1/x", status="added", title="Sub<sub>2</sub>")
    assert line.title == "Sub2"
