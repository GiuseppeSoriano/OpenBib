import { mockRefresh } from "@/test/auth-mock";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import SearchPage from "@/pages/SearchPage";
import { renderWithProviders } from "@/test/utils";
import type { PaperMetadata } from "@/types";

function paper(key: string, title: string, overrides: Partial<PaperMetadata> = {}): PaperMetadata {
  return {
    canonical_key: key,
    paper_group_key: `group:${key}`,
    title,
    authors: [{ name: "Alice Smith", openalex_id: null, orcid: null, affiliations: [] }],
    abstract: null,
    publication_date: "2024-01-01",
    doi: null,
    arxiv_id: null,
    pmid: null,
    pmcid: null,
    openalex_id: null,
    venue: "VLDB",
    volume: null,
    issue: null,
    pages: null,
    paper_type: null,
    topics: [],
    keywords: [],
    open_access: null,
    pdf_url: null,
    abstract_url: null,
    cited_by_count: 5,
    reference_count: null,
    version: null,
    provider_source: "openalex",
    provider_sources: ["openalex"],
    ...overrides,
  };
}

const groupV1 = paper("hash:v1", "Grouped Paper", {
  paper_group_key: "group:g",
  version: "v1",
  provider_source: "arxiv",
});
const groupV2 = paper("hash:v2", "Grouped Paper", {
  paper_group_key: "group:g",
  publication_date: "2025-02-01",
  provider_source: "crossref",
});

const searchResponse = {
  items: [
    { kind: "paper", paper: paper("doi:10.1/solo", "Solo Paper") },
    {
      kind: "paper_group",
      paper_group_key: "group:g",
      title: "Grouped Paper",
      authors: [],
      version_count: 2,
      selected_version: groupV2,
      versions: [groupV2, groupV1],
      provider_sources: ["arxiv", "crossref"],
    },
  ],
  total_count: 2,
  raw_total_count: 3,
  page: 1,
  page_size: 20,
  providers: ["openalex", "crossref"],
};

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn((url: string) => {
      if (url === "/papers/search") return Promise.resolve({ data: searchResponse });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  papers: { getDetail: vi.fn() },
  library: { listKeys: vi.fn(() => Promise.resolve([])) },
  notes: {},
  graph: {},
  zotero: {},
}));

describe("SearchPage", () => {
  it("runs the query from the URL and renders results", async () => {
    renderWithProviders(<SearchPage />, { route: "/search?q=databases" });

    expect(await screen.findByText("Solo Paper")).toBeInTheDocument();
    expect(screen.getByText("Grouped Paper")).toBeInTheDocument();
    expect(screen.getByText(/2 grouped results from/)).toBeInTheDocument();
  });

  it("shows a humanized version picker for grouped results", async () => {
    renderWithProviders(<SearchPage />, { route: "/search?q=databases" });
    await screen.findByText("Grouped Paper");

    const picker = screen.getByTestId("version-picker");
    expect(picker).toHaveTextContent("Published 2025 · Crossref");
    expect(picker).toHaveTextContent("Preprint v1 · arXiv");
  });

  it("hides user-scoped filter pills for anonymous visitors", async () => {
    renderWithProviders(<SearchPage />, { route: "/search?q=databases" });
    await screen.findByText("Solo Paper");

    expect(screen.queryByText("Unsaved only")).toBeNull();
    expect(screen.queryByText("Hide dismissed")).toBeNull();
    // Anonymous cards expose exploration only — no save/dismiss actions.
    expect(screen.queryByText("Save to Library")).toBeNull();
  });
});
