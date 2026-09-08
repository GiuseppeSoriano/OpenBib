import { mockRefresh } from "@/test/auth-mock";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import GraphPage from "@/pages/GraphPage";
import { renderWithProviders } from "@/test/utils";
import type { PaperMetadata } from "@/types";

// The canvas engine cannot run in jsdom — replace it with a stub.
vi.mock("react-force-graph-2d", async () => {
  const { forwardRef } = await import("react");
  return { default: forwardRef(function GraphStub() { return <div data-testid="force-graph-stub" />; }) };
});

const seedPaper: PaperMetadata = {
  canonical_key: "hash:seed",
  paper_group_key: "group:seed",
  title: "Seed Paper",
  authors: [{ name: "Alice Smith", openalex_id: null, orcid: null, affiliations: [] }],
  abstract: null,
  publication_date: "2020-01-01",
  doi: null,
  arxiv_id: null,
  pmid: null,
  pmcid: null,
  openalex_id: null,
  venue: "NeurIPS",
  volume: null,
  issue: null,
  pages: null,
  paper_type: null,
  topics: [],
  keywords: [],
  open_access: null,
  pdf_url: null,
  abstract_url: null,
  cited_by_count: 10,
  reference_count: null,
  version: null,
  provider_source: "openalex",
  provider_sources: ["openalex"],
};

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  graph: {
    buildPaper: vi.fn(() =>
      Promise.resolve({
        active_paper_key: "hash:seed",
        active_paper_group_key: "group:seed",
        nodes: [
          {
            id: "group:seed",
            label: "Seed Paper",
            type: "paper",
            paper_group_key: "group:seed",
            version_count: 1,
            selected_version: seedPaper,
            versions: [seedPaper],
            is_seed: true,
          },
        ],
        edges: [],
      }),
    ),
    expand: vi.fn(),
  },
  papers: { getDetail: vi.fn() },
  library: { listKeys: vi.fn(() => Promise.resolve([])) },
  notes: {},
  zotero: {},
}));

function renderGraph(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/graph/:paperKey" element={<GraphPage mode="paper" />} />
      <Route path="/graph" element={<GraphPage mode="manual" />} />
    </Routes>,
    { route },
  );
}

describe("GraphPage", () => {
  it("renders the full-viewport canvas with the expansion bar (no search input)", async () => {
    renderGraph("/graph/hash:seed");

    expect(await screen.findByTestId("force-graph-stub")).toBeInTheDocument();
    const bar = screen.getByTestId("expand-bar");
    expect(bar).toHaveTextContent("Citers");
    expect(bar).toHaveTextContent("References");
    expect(bar).toHaveTextContent("Top cited");
    expect(bar).toHaveTextContent("Most recent");
    expect(bar).toHaveTextContent("Expand entire graph");
    // The old paper-key search bar is gone.
    expect(screen.queryByPlaceholderText(/canonical key/i)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows the graph context chip and counts", async () => {
    renderGraph("/graph/hash:seed");
    await screen.findByTestId("force-graph-stub");
    expect(screen.getByText("Paper")).toBeInTheDocument();
    expect(screen.getByText("1 nodes · 0 edges")).toBeInTheDocument();
  });

  it("manual mode shows an entry-point empty state instead of a key input", async () => {
    renderGraph("/graph");
    expect(await screen.findByTestId("empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("expand-bar")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
