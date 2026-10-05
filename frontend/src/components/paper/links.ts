import type { PaperMetadata } from "@/types";

export interface FullTextLink {
  /** "pdf" only when the URL itself points at a PDF file. */
  kind: "pdf" | "fulltext";
  url: string;
  host: string;
}

const PDF_QUERY = /[?&](?:format|type|mimetype|mime|output)=[^&]*pdf|[?&]pdf=render/i;
// Semantic Scholar's paper pages (its `url`, stored as abstract_url) are
// landing pages; PDFs it hosts live on other hosts (pdfs.semanticscholar.org).
const SEMANTIC_SCHOLAR_HOSTS = new Set(["semanticscholar.org", "www.semanticscholar.org"]);
const S2_PAPER_ID = /^[0-9a-f]{40}$/i;

function parseHttpUrl(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

/** Host shown in a link's tooltip, without a leading "www.". */
export function linkHost(url: string): string {
  const parsed = parseHttpUrl(url);
  return parsed ? parsed.hostname.replace(/^www\./, "") : "";
}

/**
 * Whether a URL points at a PDF file rather than a landing page: a `.pdf`
 * path, a `/pdf` path segment (arXiv, PMC, MDPI) or a PDF render parameter.
 * Provider "pdf_url" fields often hold repository pages (figshare, Zenodo),
 * which must not be labelled as a PDF download.
 */
export function looksLikePdf(url: string | null | undefined): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  const path = parsed.pathname.toLowerCase();
  return path.endsWith(".pdf") || /\/pdf(?:\/|$)/.test(path) || PDF_QUERY.test(parsed.search);
}

function sameLink(a: URL, b: URL): boolean {
  const norm = (u: URL) =>
    `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  return norm(a) === norm(b);
}

function isSemanticScholarPage(parsed: URL, raw: string): boolean {
  return SEMANTIC_SCHOLAR_HOSTS.has(parsed.hostname.toLowerCase()) && !looksLikePdf(raw);
}

/**
 * Full-text links of a paper, PDFs first. Skips anything that is not http(s),
 * DOI resolver links, the arXiv abstract page, the PubMed record and the
 * Semantic Scholar paper page (each has its own chip), and duplicates.
 */
export function fullTextLinks(paper: PaperMetadata): FullTextLink[] {
  const seen: URL[] = [];
  const links: FullTextLink[] = [];
  for (const raw of [paper.pdf_url, paper.abstract_url]) {
    const parsed = parseHttpUrl(raw);
    if (!parsed || !raw) continue;
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "doi.org" || host === "dx.doi.org") continue;
    if (paper.arxiv_id && host === "arxiv.org" && parsed.pathname.startsWith("/abs/")) continue;
    if (host === "pubmed.ncbi.nlm.nih.gov" && pubmedUrl(paper)) continue;
    if (isSemanticScholarPage(parsed, raw)) continue;
    if (seen.some((other) => sameLink(other, parsed))) continue;
    seen.push(parsed);
    links.push({ kind: looksLikePdf(raw) ? "pdf" : "fulltext", url: raw, host });
  }
  return links.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "pdf" ? -1 : 1));
}

/**
 * The paper's Semantic Scholar page: the stored landing URL, otherwise one
 * built from its paper ID. Shown as its own link, never as full text.
 */
export function semanticScholarUrl(paper: PaperMetadata): string | null {
  for (const raw of [paper.abstract_url, paper.pdf_url]) {
    const parsed = parseHttpUrl(raw);
    if (parsed && raw && isSemanticScholarPage(parsed, raw)) return raw;
  }
  const key = paper.canonical_key.toLowerCase();
  const id = paper.semantic_scholar_id ?? (key.startsWith("s2:") ? key.slice(3) : null);
  return id && S2_PAPER_ID.test(id) ? `https://www.semanticscholar.org/paper/${id.toLowerCase()}` : null;
}

/** The PubMed record for a numeric PMID. */
export function pubmedUrl(paper: PaperMetadata): string | null {
  const pmid = paper.pmid?.trim();
  return pmid && /^\d+$/.test(pmid) ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null;
}
