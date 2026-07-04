import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import CollectionDetailPage from "@/pages/CollectionDetailPage";
import { renderWithProviders } from "@/test/utils";

const collection = {
  id: "c1",
  owner_id: "u1",
  name: "Deep Learning Classics",
  description: "Foundational papers",
  visibility: "private",
  created_at: "2026-01-15T10:00:00Z",
  paper_count: 1,
};

const hydratedRow = {
  paper_canonical_key: "doi:10.1/attention",
  paper_group_key: "group:attention",
  position: 0,
  added_at: "2026-02-01T10:00:00Z",
  paper: {
    canonical_key: "doi:10.1/attention",
    paper_group_key: "group:attention",
    title: "Attention Is All You Need",
    authors: [{ name: "Ashish Vaswani", openalex_id: null, orcid: null, affiliations: [] }],
    abstract: null,
    publication_date: "2017-06-12",
    doi: "10.1/attention",
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
    open_access: true,
    pdf_url: null,
    abstract_url: null,
    cited_by_count: 100000,
    reference_count: null,
    version: null,
    provider_source: "openalex",
    provider_sources: ["openalex"],
  },
};

vi.mock("@/lib/api", () => {
  const get = vi.fn((url: string) => {
    if (url === "/users/me")
      return Promise.resolve({
        data: { id: "u1", email: "me@example.com", display_name: "Me", created_at: "2026-01-01" },
      });
    if (url === "/collections/c1") return Promise.resolve({ data: collection });
    if (url === "/collections/c1/papers") return Promise.resolve({ data: [hydratedRow] });
    return Promise.resolve({ data: [] });
  });
  return {
    default: { get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
    papers: {
      getStates: vi.fn(() => Promise.resolve([])),
      getDetail: vi.fn(() => Promise.resolve({ ...hydratedRow.paper, versions: [] })),
    },
    library: { listKeys: vi.fn(() => Promise.resolve([])) },
    notes: { listForPaperGroup: vi.fn(() => Promise.resolve([])) },
    graph: {},
  };
});

function renderPage() {
  // Simulate an authenticated session: AuthProvider hydrates from /users/me.
  localStorage.setItem("access_token", "test-token");
  return renderWithProviders(
    <Routes>
      <Route path="/collections/:id" element={<CollectionDetailPage />} />
    </Routes>,
    { route: "/collections/c1" },
  );
}

describe("CollectionDetailPage", () => {
  it("renders papers with full metadata instead of canonical keys", async () => {
    renderPage();

    expect(await screen.findByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.getByText("Ashish Vaswani")).toBeInTheDocument();
    expect(screen.getByText("NeurIPS")).toBeInTheDocument();
    expect(screen.getByText("2017")).toBeInTheDocument();
    // The raw canonical key must no longer be the visible label.
    expect(screen.queryByText("doi:10.1/attention")).toBeNull();
  });

  it("shows the collection header with translated metadata", async () => {
    renderPage();

    expect(await screen.findByText("Deep Learning Classics")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText(/1 paper ·/)).toBeInTheDocument();
  });

  it("exposes a reading-state selector on each paper row", async () => {
    renderPage();
    await screen.findByText("Attention Is All You Need");
    expect(screen.getByTestId("reading-state-select")).toBeInTheDocument();
  });
});
