import type { PaperMetadata } from "@/types";

export interface FullTextLink {
  /** "pdf" only when the URL itself points at a PDF file. */
  kind: "pdf" | "fulltext";
  url: string;
  host: string;
}

const PDF_QUERY = /[?&](?:format|type|mimetype|mime|output)=[^&]*pdf|[?&]pdf=render/i;

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

/**
 * Full-text links of a paper, PDFs first. Skips anything that is not http(s),
 * DOI resolver links and the arXiv abstract page (both have their own chips),
 * and duplicates.
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
    if (seen.some((other) => sameLink(other, parsed))) continue;
    seen.push(parsed);
    links.push({ kind: looksLikePdf(raw) ? "pdf" : "fulltext", url: raw, host });
  }
  return links.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "pdf" ? -1 : 1));
}
