import { describe, it, expect } from "vitest";
import i18n from "@/i18n";
import { providerLabel, versionLabel, versionLabels } from "@/components/paper/versionLabel";
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

describe("versionLabels", () => {
  const t = i18n.t.bind(i18n);
  const crossrefPreprint = (overrides: Partial<PaperMetadata>) =>
    paper({ provider_source: "crossref", paper_type: "posted-content", ...overrides });

  function expectDistinct(labels: Map<string, { label: string; accessibleName: string }>) {
    const values = [...labels.values()];
    expect(new Set(values.map((v) => v.label)).size).toBe(values.length);
    expect(new Set(values.map((v) => v.accessibleName)).size).toBe(values.length);
    for (const value of values) {
      expect(`${value.label} ${value.accessibleName}`).not.toMatch(/10\.\d{2,}|doi:/);
    }
  }

  it("keeps labels that are already distinct", () => {
    const labels = versionLabels(
      [
        paper({ canonical_key: "a", version: "v2", provider_source: "arxiv", doi: null }),
        paper({ canonical_key: "b", publication_date: "2017-06-12", provider_source: "crossref" }),
      ],
      t,
      "en",
    );
    expect(labels.get("a")?.label).toBe("Preprint v2 · arXiv");
    expect(labels.get("b")?.label).toBe("Published 2017 · Crossref");
    expect(labels.get("b")?.details).toBe("Jun 12, 2017 · Crossref");
    expect(labels.get("b")?.accessibleName).toBe(
      "Published 2017 · Crossref, Jun 12, 2017 · Crossref",
    );
  });

  it("adds the posted date to same-year preprints", () => {
    const labels = versionLabels(
      [
        crossrefPreprint({ canonical_key: "doi:10.20944/p.v1", doi: "10.20944/p.v1", publication_date: "2021-01-04" }),
        crossrefPreprint({ canonical_key: "doi:10.20944/p.v2", doi: "10.20944/p.v2", publication_date: "2021-03-09" }),
      ],
      t,
      "en",
    );
    expect(labels.get("doi:10.20944/p.v1")?.label).toBe("Preprint 2021 · Crossref · Posted Jan 4, 2021");
    expect(labels.get("doi:10.20944/p.v2")?.label).toBe("Preprint 2021 · Crossref · Posted Mar 9, 2021");
    expectDistinct(labels);
  });

  it("falls back to venue, then citations, when there is no year", () => {
    const labels = versionLabels(
      [
        crossrefPreprint({ canonical_key: "a", venue: "Preprints.org" }),
        crossrefPreprint({ canonical_key: "b", venue: "Research Square" }),
        crossrefPreprint({ canonical_key: "c", venue: "Research Square", cited_by_count: 3 }),
      ],
      t,
      "en",
    );
    expect(labels.get("a")?.label).toBe("Preprint · Crossref · Preprints.org");
    expect(labels.get("b")?.label).toBe("Preprint · Crossref · Research Square");
    expect(labels.get("c")?.label).toBe("Preprint · Crossref · Research Square · 3 citations");
    expectDistinct(labels);
  });

  it("numbers versions with identical metadata", () => {
    const labels = versionLabels(
      [crossrefPreprint({ canonical_key: "a" }), crossrefPreprint({ canonical_key: "b" })],
      t,
      "en",
    );
    expect(labels.get("a")?.label).toBe("Preprint · Crossref · 1 of 2");
    expect(labels.get("b")?.label).toBe("Preprint · Crossref · 2 of 2");
    expectDistinct(labels);
  });

  it("uses the locale for dates and ordinals", () => {
    const labels = versionLabels(
      [crossrefPreprint({ canonical_key: "a" }), crossrefPreprint({ canonical_key: "b" })],
      i18n.getFixedT("it"),
      "it",
    );
    expect(labels.get("b")?.label).toBe("Preprint · Crossref · 2 di 2");
  });
});
