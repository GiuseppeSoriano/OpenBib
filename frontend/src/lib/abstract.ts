/**
 * Abstract text for display. The API already returns plain text (paragraphs
 * separated by a blank line, section headings folded into "Heading: "), so
 * this mostly splits paragraphs and finds their labels. Markup that still
 * slips through is stripped defensively: parsed with DOMParser (which never
 * runs scripts) and read back as text — it is never injected as HTML.
 */

export interface AbstractParagraph {
  /** Section label such as "Background", shown in bold. */
  label?: string;
  text: string;
}

// Mirrors the backend (app/common/text.py): only known tag names, with
// name=value attributes, count as markup, so "Box<T>", "<mask>" or
// "x<a and y>b" stay literal text.
const TAG = /<\/?([a-z][\w.-]*(?::[a-z][\w.-]*)?)(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))*\s*\/?>/gi;
const MARKUP_PREFIXES = new Set(["jats", "mml", "xhtml", "html"]);
const DROPPED_TAGS = new Set(["script", "style", "annotation", "annotation-xml"]);
const KNOWN_TAGS = new Set([
  ...DROPPED_TAGS,
  ..."abstract article blockquote br caption dd div dl dt hr li list list-item ol p sec section".split(" "),
  ..."table tbody td tfoot th thead tr trans-abstract ul h1 h2 h3 h4 h5 h6 title".split(" "),
  ..."a abbr b big bold cite code em ext-link font i inline-formula italic label math mi mn mo".split(" "),
  ..."mrow msub msup mtext monospace named-content sc scp semantics small span strike strong".split(" "),
  ..."styled-content sub sup tt u underline xref".split(" "),
]);
const HEADING = /<((?:jats:)?title|h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const BLOCK_END = /<\/(?:p|div|li|tr|section|sec|abstract|jats:p|jats:sec|jats:list-item)\s*>|<br\s*\/?>/gi;
const CELL = /<\/?(?:jats:)?t[dh]\b[^>]*>/gi;
const SUP = /<(?:jats:)?sup\b[^>]*>/gi;
const DROPPED = /^(?:script|style|(?:[\w-]+:)?annotation(?:-xml)?)$/;
const PARAGRAPH_BREAK = /\n\s*\n/;
const LABEL = /^([A-Z][\w ,/&()-]{1,40}):\s+/;
const PREVIEW_MAX = 600;

function localName(name: string): { prefix: string; local: string } {
  const lower = name.toLowerCase();
  const colon = lower.lastIndexOf(":");
  return { prefix: colon < 0 ? "" : lower.slice(0, colon), local: lower.slice(colon + 1) };
}

function isMarkup(name: string): boolean {
  const { prefix, local } = localName(name);
  return prefix ? MARKUP_PREFIXES.has(prefix) : KNOWN_TAGS.has(local);
}

/**
 * Keeps known tags and escapes every other "<" so the HTML parser reads it as
 * text. A dropped element counts only when its end tag follows, so a literal
 * "<script>" mention does not swallow the rest of the text. Returns null when
 * there is no markup at all.
 */
function escapeNonMarkup(text: string): string | null {
  const tags: RegExpExecArray[] = [];
  const lastClose = new Map<string, number>();
  TAG.lastIndex = 0;
  for (let match = TAG.exec(text); match; match = TAG.exec(text)) {
    const name = match[1] ?? "";
    if (!isMarkup(name)) continue;
    tags.push(match);
    if (match[0].startsWith("</")) lastClose.set(localName(name).local, match.index);
  }
  let out = "";
  let last = 0;
  for (const match of tags) {
    const tag = match[0];
    const { local } = localName(match[1] ?? "");
    const end = match.index + tag.length;
    const unclosed = !tag.startsWith("</") && !tag.endsWith("/>") && (lastClose.get(local) ?? -1) < end;
    if (DROPPED_TAGS.has(local) && unclosed) continue;
    out += text.slice(last, match.index).replace(/</g, "&lt;") + tag;
    last = end;
  }
  if (!last) return null;
  return out + text.slice(last).replace(/</g, "&lt;");
}

function stripMarkup(text: string): string {
  if (typeof DOMParser === "undefined") return text;
  const escaped = escapeNonMarkup(text);
  if (escaped === null) return text;
  const marked = escaped
    .replace(HEADING, "\n\n$2: ")
    .replace(BLOCK_END, "\n\n")
    .replace(CELL, " ")
    .replace(SUP, "^");
  const doc = new DOMParser().parseFromString(marked, "text/html");
  doc.body.querySelectorAll("*").forEach((element) => {
    if (DROPPED.test(element.tagName.toLowerCase())) element.remove();
  });
  return doc.body.textContent ?? "";
}

/** Paragraphs of an abstract, each with its optional section label. */
export function abstractParagraphs(text: string | null | undefined): AbstractParagraph[] {
  if (!text) return [];
  const paragraphs: AbstractParagraph[] = [];
  for (const chunk of stripMarkup(text).split(PARAGRAPH_BREAK)) {
    const clean = chunk.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const match = LABEL.exec(clean);
    const label = match?.[1]?.trim();
    const rest = match ? clean.slice(match[0].length).trim() : "";
    if (label && rest) {
      paragraphs.push({ label, text: rest });
    } else {
      paragraphs.push({ text: clean });
    }
  }
  return paragraphs;
}

/** One-line plain-text preview for cards (labels kept inline). */
export function abstractPreview(text: string | null | undefined, max = PREVIEW_MAX): string {
  const preview = abstractParagraphs(text)
    .map((paragraph) => (paragraph.label ? `${paragraph.label}: ${paragraph.text}` : paragraph.text))
    .join(" ");
  return preview.length > max ? `${preview.slice(0, max - 1).trimEnd()}…` : preview;
}
