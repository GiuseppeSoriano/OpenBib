import { describe, it, expect } from "vitest";
import i18n from "@/i18n";
import { providerLabel, versionLabel } from "@/components/paper/versionLabel";
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

describe("providerLabel", () => {
  it("maps known providers to display names", () => {
    expect(providerLabel("semantic_scholar")).toBe("Semantic Scholar");
    expect(providerLabel("openalex")).toBe("OpenAlex");
    expect(providerLabel("europepmc")).toBe("Europe PMC");
    expect(providerLabel(null)).toBe("—");
  });
});

describe("versionLabel", () => {
  const t = i18n.t.bind(i18n);

  it("labels arXiv-style versions as preprints with their version", () => {
    const label = versionLabel(
      paper({ version: "v2", provider_source: "arxiv", arxiv_id: "2306.1", doi: null }),
      t,
    );
    expect(label).toBe("Preprint v2 · arXiv");
  });

  it("labels published papers with their year and provider", () => {
    const label = versionLabel(
      paper({ publication_date: "2017-06-12", provider_source: "crossref" }),
      t,
    );
    expect(label).toBe("Published 2017 · Crossref");
  });

  it("labels preprint types without a version by year", () => {
    const label = versionLabel(
      paper({ paper_type: "preprint", publication_date: "2023-01-01" }),
      t,
    );
    expect(label).toBe("Preprint 2023 · OpenAlex");
  });

  it("falls back to undated", () => {
    const label = versionLabel(paper({}), t);
    expect(label).toBe("Undated · OpenAlex");
  });

  it("never contains a raw DOI or canonical key", () => {
    const label = versionLabel(paper({ publication_date: "2020-05-05" }), t);
    expect(label).not.toMatch(/10\.\d{4,}/);
    expect(label).not.toContain("doi:");
  });
});
