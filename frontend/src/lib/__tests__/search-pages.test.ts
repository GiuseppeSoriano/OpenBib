import { describe, expect, it } from "vitest";
import { mergeSearchPages, nextSearchPage, resultElementId } from "@/lib/search-pages";
import type { PaperMetadata, SearchResult } from "@/types";

function paper(key: string, group: string): PaperMetadata {
  return {
    canonical_key: key, paper_group_key: group, title: key, authors: [], abstract: null,
    publication_date: null, doi: null, arxiv_id: null, pmid: null, pmcid: null, openalex_id: null,
    venue: null, volume: null, issue: null, pages: null, paper_type: null, topics: [], keywords: [],
    open_access: null, pdf_url: null, abstract_url: null, cited_by_count: null, reference_count: null,
    version: null, provider_source: "semantic_scholar", provider_sources: ["semantic_scholar"],
  };
}

function page(overrides: Partial<SearchResult>): SearchResult {
  return {
    items: [], total_count: 0, raw_total_count: 0, has_more: false, page: 1, page_size: 20,
    providers: ["semantic_scholar"], ...overrides,
  };
}

describe("mergeSearchPages", () => {
  it("unions possible other versions across pages, never pointing at itself", () => {
    const related = { paper_group_key: "group:b", title: "B", provider_sources: [] };
    const merged = mergeSearchPages([
      page({ items: [{ kind: "paper", paper: paper("s2:a1", "group:a"), possible_versions: [related] }] }),
      page({
        page: 2,
        items: [{
          kind: "paper", paper: paper("s2:a2", "group:a"),
          possible_versions: [related, { paper_group_key: "group:a", title: "A", provider_sources: [] }],
        }],
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.kind).toBe("paper_group");
    expect(merged[0]!.possible_versions).toEqual([related]);
  });
});

describe("nextSearchPage", () => {
  it("counts pages for relevance until the provider window is reached", () => {
    expect(nextSearchPage({ q: "x" }, page({ page: 3, has_more: true }))).toEqual({ page: 4 });
    expect(nextSearchPage({ q: "x" }, page({ has_more: false }))).toBeUndefined();
    expect(nextSearchPage({ q: "x" }, page({ has_more: true, window_capped: true }))).toBeUndefined();
  });

  it("follows the server cursor for the date and citation sorts", () => {
    expect(nextSearchPage({ q: "x", sort: "date" }, page({ next_cursor: "c2", has_more: true }))).toEqual({ cursor: "c2" });
    expect(nextSearchPage({ q: "x", sort: "citations" }, page({ next_cursor: null, has_more: true }))).toBeUndefined();
  });
});

describe("resultElementId", () => {
  it("gives distinct, stable ids for distinct group keys", () => {
    expect(resultElementId("group:a b")).toBe(resultElementId("group:a b"));
    expect(resultElementId("group:a")).not.toBe(resultElementId("group:b"));
    expect(resultElementId("doi:10.1/x y")).not.toMatch(/\s/);
  });
});
