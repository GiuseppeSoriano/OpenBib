import { focusManager } from "@tanstack/react-query";
import { mockRefresh } from "@/test/auth-mock";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { graph as graphApi } from "@/lib/api";
import { Link, Routes, Route } from "react-router-dom";
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
    buildCollection: vi.fn(),
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
  beforeEach(() => vi.clearAllMocks());

  it("shows a base-load failure and recovers through explicit retry", async () => {
    vi.mocked(graphApi.buildPaper).mockRejectedValueOnce({
      response: { status: 503, data: { detail: "Semantic Scholar is busy; please retry." } },
    });
    renderGraph("/graph/hash:seed");
    expect(await screen.findByRole("alert")).toHaveTextContent("Semantic Scholar is busy");
    expect(graphApi.buildPaper).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("force-graph-stub")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(graphApi.buildPaper).toHaveBeenCalledTimes(2);
  });

  it("preserves the graph on expansion failure and retries the failed request", async () => {
    vi.mocked(graphApi.expand)
      .mockRejectedValueOnce({ response: { status: 503, data: { detail: "Please retry later." } } })
      .mockResolvedValueOnce({ nodes: [], edges: [] });
    renderGraph("/graph/hash:seed");
    await screen.findByTestId("force-graph-stub");
    fireEvent.click(screen.getByRole("button", { name: "Expand entire graph" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please retry later.");
    expect(screen.getByText("1 nodes · 0 edges")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(graphApi.expand).toHaveBeenCalledTimes(2);
    expect(vi.mocked(graphApi.expand).mock.calls[1]).toEqual(vi.mocked(graphApi.expand).mock.calls[0]);
  });

  it("uses a readable fallback for network failures or non-string error details", async () => {
    vi.mocked(graphApi.buildPaper).mockRejectedValueOnce({ response: { data: { detail: [] } } });
    renderGraph("/graph/hash:seed");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load the graph");
  });

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


function collectionGraph(id = "group:seed") {
  return { active_paper_key: "", active_paper_group_key: "", nodes: [{ id, label: "Seed Paper", type: "paper" as const, paper_group_key: id, version_count: 1, selected_version: seedPaper, versions: [seedPaper], is_seed: true }], edges: [] };
}
function renderCollectionGraph() {
  return renderWithProviders(<><Link to="/graph/collection/c2">Switch collection</Link><Routes><Route path="/graph/collection/:collectionId" element={<GraphPage mode="collection" />} /></Routes></>, { route: "/graph/collection/c1#share=" + "a".repeat(43) });
}

it("clears a collection graph when its read capability is revoked", async () => {
  vi.mocked(graphApi.buildCollection).mockReset().mockResolvedValueOnce(collectionGraph()).mockRejectedValue({ response: { status: 404 } });
  renderCollectionGraph();
  await screen.findByTestId("force-graph-stub");
  expect(graphApi.buildCollection).toHaveBeenCalledWith("c1", "cited_by_count", { "X-Collection-Share-Token": "a".repeat(43) });
  focusManager.setFocused(false); focusManager.setFocused(true);
  await screen.findByText("Collection unavailable or access no longer granted.");
  expect(screen.queryByTestId("force-graph-stub")).toBeNull();
  focusManager.setFocused(undefined);
});

it("ignores an old expansion response after changing the collection access scope", async () => {
  vi.mocked(graphApi.buildCollection).mockReset().mockImplementation(async (id) => collectionGraph("group:" + id));
  let resolveExpansion: (value: ReturnType<typeof collectionGraph>) => void = () => {};
  vi.mocked(graphApi.expand).mockReset().mockReturnValue(new Promise((resolve) => { resolveExpansion = resolve; }));
  renderCollectionGraph(); await screen.findByTestId("force-graph-stub");
  fireEvent.click(screen.getByRole("button", { name: "Expand entire graph" }));
  await waitFor(() => expect(graphApi.expand).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("link", { name: "Switch collection" }));
  await waitFor(() => expect(graphApi.buildCollection).toHaveBeenCalledWith("c2", "cited_by_count", {}));
  await screen.findByTestId("force-graph-stub");
  await act(async () => resolveExpansion(collectionGraph("group:old-expansion")));
  expect(screen.getByText("1 nodes · 0 edges")).toBeInTheDocument();
});
