"""Plain-text normalization for provider titles and abstracts.

Providers hand us HTML (Europe PMC), JATS XML (Crossref), MathML fragments and
hard-wrapped plain text (arXiv). The API only returns plain text: paragraphs
separated by a blank line, with section headings folded into a ``"Heading: "``
prefix. Only recognised tag names count as markup, so literal comparisons such
as ``p < 0.05`` survive.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser

ABSTRACT_MAX_LEN = 20_000
TITLE_MAX_LEN = 2_000

# Any start, end or self-closing tag with ``name=value`` attributes only (so
# ``x<a and y>b`` stays text); whether it is markup depends on its name.
_TAG_RE = re.compile(
    r"</?([A-Za-z][\w.-]*(?::[A-Za-z][\w.-]*)?)"
    r"(?:\s+[\w:.-]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s\"'<>]+))*\s*/?>"
)
_COMMENT_RE = re.compile(r"<!--.*?(?:-->|$)|<\?[^<>]*\?>", re.DOTALL)
_PARTIAL_TAG_RE = re.compile(r"<[^<>]*$")
_BLANK_LINE_RE = re.compile(r"\n[^\S\n]*\n\s*")
_SPACE_RE = re.compile(r"\s+")
_HEADING_TRAIL_RE = re.compile(r"[\s:.]+$")

# Namespaced tags from these vocabularies are always markup.
_MARKUP_PREFIXES = frozenset({"jats", "mml", "xhtml", "html"})
_BLOCK_TAGS = frozenset(
    {
        "abstract",
        "article",
        "blockquote",
        "br",
        "dd",
        "div",
        "dl",
        "dt",
        "hr",
        "li",
        "list",
        "list-item",
        "ol",
        "p",
        "sec",
        "section",
        "caption",
        "table",
        "tbody",
        "tfoot",
        "thead",
        "tr",
        "trans-abstract",
        "ul",
    }
)
# Table cells: a space between cells, rows stay paragraphs.
_CELL_TAGS = frozenset({"td", "th"})
_HEADING_TAGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6", "title"})
_DROPPED_TAGS = frozenset({"script", "style", "annotation", "annotation-xml"})
_INLINE_TAGS = frozenset(
    {
        "a",
        "abbr",
        "b",
        "big",
        "bold",
        "cite",
        "code",
        "em",
        "ext-link",
        "font",
        "i",
        "inline-formula",
        "italic",
        "label",
        "math",
        "mi",
        "mn",
        "mo",
        "mrow",
        "msub",
        "msup",
        "mtext",
        "monospace",
        "named-content",
        "sc",
        "scp",
        "semantics",
        "small",
        "span",
        "strike",
        "strong",
        "styled-content",
        "sub",
        "sup",
        "tt",
        "u",
        "underline",
        "xref",
    }
)
_KNOWN_TAGS = _BLOCK_TAGS | _CELL_TAGS | _HEADING_TAGS | _DROPPED_TAGS | _INLINE_TAGS
# Input beyond this multiple of the output bound is never parsed.
_INPUT_FACTOR = 4
# Passes until the output is stable (entities can decode into more markup).
_MAX_PASSES = 3


def _split_tag(tag: str) -> tuple[str, str]:
    prefix, _, local = tag.lower().rpartition(":")
    return prefix, local


def _is_markup(tag: str) -> bool:
    prefix, local = _split_tag(tag)
    if prefix:
        return prefix in _MARKUP_PREFIXES
    return local in _KNOWN_TAGS


def _escape_non_markup(text: str) -> str:
    """Keep recognised tags and escape every other ``<`` so the parser reads
    it as text. A dropped element (``<script>``...) counts only when its end
    tag follows, so a literal mention does not swallow the rest of the text."""
    tags = [match for match in _TAG_RE.finditer(text) if _is_markup(match.group(1))]
    last_close = {
        _split_tag(match.group(1))[1]: match.start()
        for match in tags
        if match.group(0).startswith("</")
    }
    pieces: list[str] = []
    last = 0
    for match in tags:
        tag = match.group(0)
        local = _split_tag(match.group(1))[1]
        if (
            local in _DROPPED_TAGS
            and not tag.startswith("</")
            and not tag.endswith("/>")
            and last_close.get(local, -1) < match.end()
        ):
            continue
        pieces.append(text[last : match.start()].replace("<", "&lt;"))
        pieces.append(match.group(0))
        last = match.end()
    pieces.append(text[last:].replace("<", "&lt;"))
    return "".join(pieces)


class _TextExtractor(HTMLParser):
    """Collects text; in paragraph mode block tags end a paragraph and headings
    become a prefix of the next one, otherwise everything joins on spaces."""

    def __init__(self, *, paragraphs: bool) -> None:
        super().__init__(convert_charrefs=True)
        self._paragraphs = paragraphs
        self._drop_depth = 0
        self._heading_depth = 0
        self._heading: list[str] = []
        self._pending_heading: str | None = None
        self._current: list[str] = []
        self.paragraphs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        _, local = _split_tag(tag)
        if local in _DROPPED_TAGS:
            self._drop_depth += 1
        elif self._drop_depth:
            return
        elif local == "sup":
            self._write("^")
        elif local in _CELL_TAGS:
            self._write(" ")
        elif self._paragraphs and local in _HEADING_TAGS:
            if not self._heading_depth:
                self._flush()
            self._heading_depth += 1
        elif local in _BLOCK_TAGS or local in _HEADING_TAGS:
            self._break()

    def handle_endtag(self, tag: str) -> None:
        _, local = _split_tag(tag)
        if local in _DROPPED_TAGS:
            self._drop_depth = max(0, self._drop_depth - 1)
        elif self._drop_depth:
            return
        elif local in _CELL_TAGS:
            self._write(" ")
        elif self._paragraphs and local in _HEADING_TAGS:
            if self._heading_depth:
                self._heading_depth -= 1
                if not self._heading_depth:
                    self._end_heading()
        elif local in _BLOCK_TAGS or local in _HEADING_TAGS:
            self._break()

    def handle_data(self, data: str) -> None:
        if self._drop_depth:
            return
        if self._heading_depth or not self._paragraphs:
            self._write(data)
            return
        # Blank lines inside text also separate paragraphs (keeps a second
        # pass over already-normalized text stable).
        for index, part in enumerate(_BLANK_LINE_RE.split(data)):
            if index:
                self._flush()
            self._current.append(part)

    def _write(self, text: str) -> None:
        (self._heading if self._heading_depth else self._current).append(text)

    def _break(self) -> None:
        if self._paragraphs:
            self._flush()
        else:
            self._current.append(" ")

    def _flush(self) -> None:
        text = _SPACE_RE.sub(" ", "".join(self._current)).strip()
        self._current = []
        if not text:
            return
        if self._pending_heading:
            text = f"{self._pending_heading}: {text}"
            self._pending_heading = None
        self.paragraphs.append(text)

    def _end_heading(self) -> None:
        heading = _SPACE_RE.sub(" ", "".join(self._heading)).strip()
        heading = _HEADING_TRAIL_RE.sub("", heading)
        self._heading = []
        if not heading:
            return
        if self._pending_heading:
            # The previous heading had no body of its own.
            self.paragraphs.append(self._pending_heading)
            self._pending_heading = None
        if not self.paragraphs and heading.lower() == "abstract":
            return
        self._pending_heading = heading

    def finish(self) -> list[str]:
        self.close()
        if self._heading_depth:
            self._heading_depth = 0
            self._end_heading()
        self._flush()
        if self._pending_heading:
            self.paragraphs.append(self._pending_heading)
            self._pending_heading = None
        return self.paragraphs


def _truncate(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    cut = text[: max_len - 1]
    space = cut.rfind(" ")
    if space > max_len // 2:
        cut = cut[:space]
    return cut.rstrip() + "…"


def _clean_once(text: str, *, paragraphs: bool, max_len: int) -> str:
    limit = max_len * _INPUT_FACTOR
    if len(text) > limit:
        text = _PARTIAL_TAG_RE.sub("", text[:limit])
    if "<" not in text and "&" not in text:
        # Fast path: plain text only needs its whitespace (arXiv soft wraps).
        parts = _BLANK_LINE_RE.split(text) if paragraphs else [text]
    else:
        extractor = _TextExtractor(paragraphs=paragraphs)
        extractor.feed(_escape_non_markup(_COMMENT_RE.sub(" ", text)))
        parts = extractor.finish()
    cleaned = [_SPACE_RE.sub(" ", part).strip() for part in parts]
    separator = "\n\n" if paragraphs else " "
    return _truncate(separator.join(part for part in cleaned if part), max_len)


def _clean(text: str, *, paragraphs: bool, max_len: int) -> str:
    for _ in range(_MAX_PASSES):
        cleaned = _clean_once(text, paragraphs=paragraphs, max_len=max_len)
        if cleaned == text:
            break
        text = cleaned
    return text


def normalize_abstract(raw: str | None, *, max_len: int = ABSTRACT_MAX_LEN) -> str | None:
    """Plain-text abstract: paragraphs joined by a blank line, ``None`` when
    nothing readable is left."""
    if not raw:
        return None
    return _clean(raw, paragraphs=True, max_len=max_len) or None


def clean_inline_text(raw: str | None, *, max_len: int = TITLE_MAX_LEN) -> str:
    """Single-line plain text for titles and labels (markup unwrapped)."""
    if not raw:
        return ""
    return _clean(raw, paragraphs=False, max_len=max_len)
