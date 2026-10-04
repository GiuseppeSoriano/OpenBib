import type { Author, PaperMetadata } from "@/types";

/** APA lists up to this many authors; longer lists keep the first 19 and the last. */
const APA_MAX_AUTHORS = 20;

const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);
const FAMILY_PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "da", "di", "du", "la", "le", "dos", "das", "ter", "ten"]);

/** "Ada M." from given names: one initial per name, hyphenated names keep the hyphen. */
function initials(given: string): string {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part
        .split("-")
        .filter(Boolean)
        .map((piece) => `${piece.charAt(0).toUpperCase()}.`)
        .join("-"),
    )
    .join(" ");
}

/** Splits a display name into family and given names ("Ada Lovelace", "Lovelace, Ada"). */
function splitName(author: Author): { family: string; given: string; suffix: string } {
  const family = author.family_name?.trim();
  if (family) return { family, given: author.given_name?.trim() ?? "", suffix: "" };

  const name = author.name.trim().replace(/\s+/g, " ");
  if (name.indexOf(",") !== -1) {
    const [last = "", ...rest] = name.split(",").map((part) => part.trim());
    return { family: last, given: rest.join(" ").trim(), suffix: "" };
  }

  const parts = name.split(" ");
  let suffix = "";
  const lastPart = parts[parts.length - 1];
  if (parts.length > 2 && lastPart && NAME_SUFFIXES.has(lastPart.toLowerCase())) {
    suffix = parts.pop() ?? "";
  }
  if (parts.length === 1) return { family: parts[0] ?? "", given: "", suffix };
  // The family name is the last word plus any particles before it ("de Souza").
  let start = parts.length - 1;
  while (start > 1 && FAMILY_PARTICLES.has((parts[start - 1] ?? "").toLowerCase())) start -= 1;
  return { family: parts.slice(start).join(" "), given: parts.slice(0, start).join(" "), suffix };
}

/** "Lovelace, A. M." (APA author form). */
export function apaAuthorName(author: Author): string {
  const { family, given, suffix } = splitName(author);
  const parts = [family];
  if (given) parts.push(initials(given));
  if (suffix) parts.push(suffix);
  return parts.join(", ");
}

/** The APA author list: "A, B, & C"; past 20 authors, the first 19, an ellipsis and the last. */
export function apaAuthorList(authors: Author[]): string {
  const names = authors.filter((author) => author.name.trim() || author.family_name).map(apaAuthorName);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (names.length > APA_MAX_AUTHORS) {
    return `${names.slice(0, APA_MAX_AUTHORS - 1).join(", ")}, … ${names[names.length - 1]}`;
  }
  return `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
}

/** Ends a sentence with a period unless it already ends with punctuation. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.?!]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The paper's stable link: its DOI, else its arXiv page. */
function paperLink(paper: PaperMetadata): string | null {
  if (paper.doi) return `https://doi.org/${paper.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`;
  if (paper.arxiv_id) return `https://arxiv.org/abs/${paper.arxiv_id}`;
  return null;
}

/**
 * An APA-style reference (7th edition, plain text) for the clipboard:
 * Authors (Year). Title. Venue, volume(issue), pages. https://doi.org/…
 */
export function formatCitation(paper: PaperMetadata): string {
  const year = paper.publication_date?.slice(0, 4) || "n.d.";
  const authors = apaAuthorList(paper.authors);
  const title = sentence(paper.title);

  let source = paper.venue?.trim() ?? "";
  if (source) {
    if (paper.volume) source += `, ${paper.volume}`;
    if (paper.volume && paper.issue) source += `(${paper.issue})`;
    if (paper.pages) source += `, ${paper.pages}`;
    source = sentence(source);
  }

  // Without authors, the title takes the author position.
  const head = authors ? [sentence(authors), `(${year}).`, title] : [title, `(${year}).`];
  const parts = [...head];
  if (source) parts.push(source);
  const link = paperLink(paper);
  if (link) parts.push(link);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Copies text to the clipboard; false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy.
  }
  // The selection copy needs the text focused; focus then goes back to the
  // control that asked for the copy.
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  try {
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "sr-only";
    document.body.appendChild(area);
    area.focus({ preventScroll: true });
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
}
