import { describe, it, expect } from "vitest";
import {
  fullTextLinks,
  linkHost,
  looksLikePdf,
  pubmedUrl,
  semanticScholarUrl,
} from "@/components/paper/links";
import type { PaperMetadata } from "@/types";

function paper(overrides: Partial<PaperMetadata>): PaperMetadata {
  return {
    canonical_key: "doi:10.1/x",
    paper_group_key: "group:x",
    title: "X",
    authors: [],
    abstract: null,
    publication_date: null,
    doi: "10.1/x",
    arxiv_id: null,
    pmid: null,
    pmcid: null,
    openalex_id: null,
    venue: null,
    volume: null,
    issue: null,
    pages: null,
    paper_type: null,
    topics: [],
    keywords: [],
    open_access: null,
    pdf_url: null,
    abstract_url: null,
    cited_by_count: null,
    reference_count: null,
    version: null,
    provider_source: "openalex",
    provider_sources: ["openalex"],
    ...overrides,
  };
}

describe("looksLikePdf", () => {
  it.each([
    "https://www.biorxiv.org/content/10.1101/2020.01.01.1.full.pdf",
    "https://example.org/files/PAPER.PDF",
    "https://arxiv.org/pdf/2301.12345v2",
    "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/pdf/",
    "https://www.mdpi.com/2073-4425/11/1/1/pdf?version=1",
    "https://europepmc.org/articles/PMC123?pdf=render",
  ])("recognises %s as a PDF", (url) => {
    expect(looksLikePdf(url)).toBe(true);
  });

  it.each([
    "https://figshare.com/articles/journal_contribution/Paper/12345",
    "https://zenodo.org/records/123",
    "https://example.org/pdfs-and-more/landing",
    "javascript:alert(1)//.pdf",
    "not a url",
    null,
  ])("does not treat %s as a PDF", (url) => {
    expect(looksLikePdf(url)).toBe(false);
  });
});

describe("fullTextLinks", () => {
  it("labels a real PDF and a repository page differently, PDF first", () => {
    const links = fullTextLinks(
      paper({
        abstract_url: "https://repo.example.org/record/1",
        pdf_url: "https://oa.example.org/paper.pdf",
      }),
    );
    expect(links).toEqual([
      { kind: "pdf", url: "https://oa.example.org/paper.pdf", host: "oa.example.org" },
      { kind: "fulltext", url: "https://repo.example.org/record/1", host: "repo.example.org" },
    ]);
  });

  it("treats a non-PDF pdf_url as a full-text page", () => {
    const links = fullTextLinks(paper({ pdf_url: "https://figshare.com/articles/x/1" }));
    expect(links).toEqual([{ kind: "fulltext", url: "https://figshare.com/articles/x/1", host: "figshare.com" }]);
  });

  it("skips DOI resolver links, the arXiv abstract page, duplicates and unsafe URLs", () => {
    expect(fullTextLinks(paper({ abstract_url: "https://doi.org/10.1/x" }))).toEqual([]);
    expect(
      fullTextLinks(
        paper({ arxiv_id: "2301.1v2", abstract_url: "http://arxiv.org/abs/2301.1v2" }),
      ),
    ).toEqual([]);
    expect(
      fullTextLinks(
        paper({ pdf_url: "https://www.a.org/p/", abstract_url: "https://a.org/p" }),
      ),
    ).toHaveLength(1);
    expect(fullTextLinks(paper({ pdf_url: "javascript:alert(1)" }))).toEqual([]);
  });

  it("returns the host without www", () => {
    expect(linkHost("https://www.example.org/a")).toBe("example.org");
    expect(linkHost("nope")).toBe("");
  });
});

// A Semantic Scholar record as the API maps it: `url` -> abstract_url, openAccessPdf -> pdf_url.
const S2_ID = "3efd851140aa28e95221b55fcc5659eea97b172d";
const S2_PAGE = `https://www.semanticscholar.org/paper/${S2_ID}`;
const FIGSHARE =
  "https://figshare.com/articles/journal_contribution/The_graph_neural_network_model/27757629";

describe("Semantic Scholar records", () => {
  it("never treats the Semantic Scholar paper page as full text", () => {
    expect(fullTextLinks(paper({ abstract_url: S2_PAGE }))).toEqual([]);
    expect(fullTextLinks(paper({ abstract_url: "https://semanticscholar.org/paper/Title/abc" }))).toEqual(
      [],
    );
  });

  it("labels an open-access landing page as full text, not a PDF download", () => {
    expect(fullTextLinks(paper({ pdf_url: FIGSHARE, abstract_url: S2_PAGE }))).toEqual([
      { kind: "fulltext", url: FIGSHARE, host: "figshare.com" },
    ]);
  });

  it("keeps direct open-access PDFs, including ones Semantic Scholar hosts", () => {
    expect(
      fullTextLinks(paper({ pdf_url: "https://arxiv.org/pdf/2301.12345", abstract_url: S2_PAGE })),
    ).toEqual([{ kind: "pdf", url: "https://arxiv.org/pdf/2301.12345", host: "arxiv.org" }]);
    const hosted = "https://pdfs.semanticscholar.org/ab12/cd34.pdf";
    expect(fullTextLinks(paper({ pdf_url: hosted }))).toEqual([
      { kind: "pdf", url: hosted, host: "pdfs.semanticscholar.org" },
    ]);
  });

  it("links the Semantic Scholar page from the stored URL or the paper ID", () => {
    expect(semanticScholarUrl(paper({ abstract_url: S2_PAGE }))).toBe(S2_PAGE);
    expect(semanticScholarUrl(paper({ semantic_scholar_id: S2_ID }))).toBe(S2_PAGE);
    expect(semanticScholarUrl(paper({ canonical_key: `s2:${S2_ID.toUpperCase()}` }))).toBe(S2_PAGE);
    expect(semanticScholarUrl(paper({ abstract_url: "https://repo.example.org/record/1" }))).toBeNull();
    expect(semanticScholarUrl(paper({ semantic_scholar_id: "not-an-id" }))).toBeNull();
    expect(semanticScholarUrl(paper({ abstract_url: "javascript:alert(1)//semanticscholar.org" }))).toBeNull();
  });
});

describe("pubmedUrl", () => {
  it("links numeric PMIDs only and hides the duplicate full-text link", () => {
    expect(pubmedUrl(paper({ pmid: "12345" }))).toBe("https://pubmed.ncbi.nlm.nih.gov/12345/");
    expect(pubmedUrl(paper({ pmid: "PMC1" }))).toBeNull();
    expect(pubmedUrl(paper({ pmid: null }))).toBeNull();
    expect(
      fullTextLinks(paper({ pmid: "12345", abstract_url: "https://pubmed.ncbi.nlm.nih.gov/12345/" })),
    ).toEqual([]);
  });
});
