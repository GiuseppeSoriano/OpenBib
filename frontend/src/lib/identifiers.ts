/*
 * Paper identifiers typed or pasted by users. Mirrors the backend's
 * `app/common/identifiers.py` (same case table) so forms can reject input
 * before sending it; the server stays the authority.
 */

export type IdentifierKind = "doi" | "hash" | "s2" | "arxiv" | "pmid" | "pmcid";

export interface ParsedIdentifier {
  kind: IdentifierKind;
  /** The key the server stores or looks up, e.g. `doi:10.1/x` or `arxiv:2306.00001`. */
  canonicalKey: string;
  /** Bare lowercase DOI for `doi` identifiers, otherwise null. */
  doi: string | null;
  /** The value without its prefix: DOI, S2 paper ID, arXiv ID, PMID or PMCID. */
  lookupId: string;
}

/** Deliberately loose, like the backend: fixtures use short forms such as `10.1/x`. */
export const DOI_RE = /^10\.\d+(?:\.\d+)*\/\S+$/;
/** The longest identifier the API accepts. */
export const MAX_IDENTIFIER_LENGTH = 512;

// Whitespace (NBSP included) plus zero-width characters that ride along with copy/paste.
// An alternation, not a character class: the zero-width joiner in a class
// reads as a joined sequence (no-misleading-character-class).
const EDGE_RE = /^(?:\s|\u200b|\u200c|\u200d|\u2060|\ufeff)+|(?:\s|\u200b|\u200c|\u200d|\u2060|\ufeff)+$/g;
const DOI_PREFIX_RE = /^(?:https?:\/\/(?:dx\.|www\.)?doi\.org\/|(?:dx\.|www\.)?doi\.org\/|doi:\s*|doi\s+)/i;
const URL_FORM_RE = /:\/\/|doi\.org/i;
const HASH_RE = /^hash:\S{1,500}$/;
const S2_KEY_RE = /^s2:([0-9a-f]{40})$/i;
// Links may carry one title slug before the 40-hex paperId.
const S2_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?semanticscholar\.org\/paper\/(?:[^/?#\s]+\/)?([0-9a-f]{40})\/?(?:[?#]\S*)?$/i;
// New-style (2306.00001v2) and old-style (hep-th/9901001) IDs; only new-style
// IDs are recognized without an `arxiv:` prefix or a link.
const ARXIV_RE =
  /^(?:arxiv:\s*|(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z][a-z.-]*\/\d{7}(?:v\d+)?)(?:\.pdf)?\/?(?:[?#]\S*)?$/i;
const ARXIV_BARE_RE = /^(\d{4}\.\d{4,5}(?:v\d+)?)$/;
const PMID_RE = /^pmid:\s*(\d{1,9})$/i;
const PMCID_RE = /^pmcid:\s*pmc(\d{1,9})$/i;

export function stripEdges(value: string): string {
  return value.replace(EDGE_RE, "");
}

/** Lenient percent-decoding: malformed sequences stay as written. */
function unquote(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%([0-9A-Fa-f]{2})/g, (match, hex: string) => {
      const code = parseInt(hex, 16);
      return code < 0x80 ? String.fromCharCode(code) : match;
    });
  }
}

/**
 * Remove DOI resolver/label prefixes and surrounding whitespace. Percent
 * escapes are decoded only with `decode` and only in URL forms, so a `doi:`
 * key containing `%2F` is never rewritten. Trailing punctuation is kept.
 */
export function stripDoiPrefixes(value: string, { decode = false } = {}): string {
  let cleaned = stripEdges(value);
  if (decode && cleaned.includes("%") && URL_FORM_RE.test(cleaned)) {
    cleaned = stripEdges(unquote(cleaned));
  }
  for (let i = 0; i < 3; i++) {
    const stripped = cleaned.replace(DOI_PREFIX_RE, "");
    if (stripped === cleaned) break;
    cleaned = stripEdges(stripped);
  }
  return cleaned;
}

/** Bare lowercase DOI, or null when the input is not DOI-shaped. */
export function normalizeDoi(raw: string, { decode = true } = {}): string | null {
  const doi = stripDoiPrefixes(raw, { decode }).toLowerCase();
  return DOI_RE.test(doi) ? doi : null;
}

/** arXiv ID without URL, prefix, `.pdf` or version suffix (like `identity.normalize_arxiv`). */
export function normalizeArxiv(value: string): string {
  const id = value
    .trim()
    .replace(/^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:)/i, "")
    .replace(/\.pdf$/i, "");
  return id.replace(/v\d+$/i, "").toLowerCase();
}

function arxivIdentifier(id: string): ParsedIdentifier {
  const normalized = normalizeArxiv(id);
  return { kind: "arxiv", canonicalKey: `arxiv:${normalized}`, doi: null, lookupId: normalized };
}

/**
 * Strict parsing, as on the server's write paths: a DOI in any accepted
 * form, a Semantic Scholar key or paper link, an arXiv ID or link, a PMID
 * or PMCID with its prefix, or an existing `hash:` key. Null when invalid.
 */
export function parseIdentifier(raw: string): ParsedIdentifier | null {
  const value = stripEdges(raw);
  if (!value || value.length > MAX_IDENTIFIER_LENGTH) return null;
  if (HASH_RE.test(value)) return { kind: "hash", canonicalKey: value, doi: null, lookupId: value };

  const s2 = S2_KEY_RE.exec(value) ?? S2_URL_RE.exec(value);
  if (s2) {
    const id = s2[1]!.toLowerCase();
    return { kind: "s2", canonicalKey: `s2:${id}`, doi: null, lookupId: id };
  }

  const arxiv = ARXIV_RE.exec(value) ?? ARXIV_BARE_RE.exec(value);
  if (arxiv) return arxivIdentifier(arxiv[1]!);

  const pmid = PMID_RE.exec(value);
  if (pmid) return { kind: "pmid", canonicalKey: `pmid:${pmid[1]}`, doi: null, lookupId: pmid[1]! };
  const pmcid = PMCID_RE.exec(value);
  if (pmcid) {
    const id = `PMC${pmcid[1]}`;
    return { kind: "pmcid", canonicalKey: `pmcid:${id}`, doi: null, lookupId: id };
  }
  // A strong prefix with a malformed value is never read as a DOI.
  if (/^(?:s2|arxiv|pmid|pmcid):/i.test(value)) return null;

  const doi = normalizeDoi(value);
  return doi ? { kind: "doi", canonicalKey: `doi:${doi}`, doi, lookupId: doi } : null;
}

export interface IdentifierLine {
  /** 1-based line number in the pasted text. */
  line: number;
  /** The line without surrounding whitespace. */
  input: string;
  identifier: ParsedIdentifier;
}

export interface IdentifierList {
  /** First occurrence of each distinct identifier, in paste order. */
  valid: IdentifierLine[];
  invalid: { line: number; value: string }[];
  /** Later lines naming an identifier already listed at `firstLine`. */
  duplicates: { line: number; value: string; firstLine: number }[];
}

/** Parse pasted text with one identifier per line; blank lines are ignored. */
export function parseIdentifierList(text: string): IdentifierList {
  const result: IdentifierList = { valid: [], invalid: [], duplicates: [] };
  const firstLines = new Map<string, number>();
  text.split(/\r\n|\r|\n/).forEach((raw, index) => {
    const line = index + 1;
    const value = stripEdges(raw);
    if (!value) return;
    const identifier = parseIdentifier(value);
    if (!identifier) {
      result.invalid.push({ line, value });
      return;
    }
    const firstLine = firstLines.get(identifier.canonicalKey);
    if (firstLine !== undefined) {
      result.duplicates.push({ line, value, firstLine });
      return;
    }
    firstLines.set(identifier.canonicalKey, line);
    result.valid.push({ line, input: value, identifier });
  });
  return result;
}

/** The doi.org resolver link for a bare DOI. */
export function doiUrl(doi: string): string {
  return `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`;
}

export type StoredKeyView =
  | { kind: "doi" | "arxiv" | "s2" | "pmid" | "pmcid"; value: string; url: string }
  | { kind: "hash" }
  | { kind: "invalid"; value: string };

/**
 * How a stored paper key is shown when its details are missing: a link for
 * a recognizable identifier, the plain text of anything else, and never the
 * raw text of an internal `hash:` key.
 */
export function describeStoredKey(key: string): StoredKeyView {
  const parsed = parseIdentifier(key);
  // An invalid DOI-shaped key (`doi:not-a-doi`) is shown, and fixed, without its prefix.
  if (!parsed) return { kind: "invalid", value: stripDoiPrefixes(key) || stripEdges(key) };
  const id = parsed.lookupId;
  switch (parsed.kind) {
    case "hash":
      return { kind: "hash" };
    case "doi":
      return { kind: "doi", value: id, url: doiUrl(id) };
    case "arxiv":
      return { kind: "arxiv", value: id, url: `https://arxiv.org/abs/${id}` };
    case "s2":
      return { kind: "s2", value: id, url: `https://www.semanticscholar.org/paper/${id}` };
    case "pmid":
      return { kind: "pmid", value: id, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/` };
    case "pmcid":
      return { kind: "pmcid", value: id, url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${id}/` };
  }
}
