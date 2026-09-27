import api, { refreshAccessToken } from "@/lib/api";
import { focusManager } from "@tanstack/react-query";
import { testAuth, mockRefresh } from "@/test/auth-mock";
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import CollectionDetailPage from "@/pages/CollectionDetailPage";
import { renderWithProviders } from "@/test/utils";

const collection = {
  id: "c1",
  owner_id: "u1",
  name: "Deep Learning Classics",
  description: "Foundational papers",
  revision: 1, is_owner: true, can_edit: true, can_manage_access: true,
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
    refreshAccessToken: vi.fn(() => mockRefresh()),
    setAccessToken: vi.fn(),
    setAuthFailureHandler: vi.fn(),
    default: { get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
    papers: {
      getStates: vi.fn(() => Promise.resolve([])),
      getDetail: vi.fn(() => Promise.resolve({ ...hydratedRow.paper, versions: [] })),
    },
    library: { listKeys: vi.fn(() => Promise.resolve([])) },
    notes: { listForPaperGroup: vi.fn(() => Promise.resolve([])) },
    graph: {},
    zotero: {
      getStatus: vi.fn(() =>
        Promise.resolve({ connected: false, zotero_user_id: null, api_key_masked: null }),
      ),
    },
  };
});

function renderPage(authenticated = true, hash = "") {
  // Simulate an authenticated session: AuthProvider hydrates from /users/me.
  testAuth.authenticated = authenticated;
  return renderWithProviders(
    <Routes>
      <Route path="/collections/:id" element={<CollectionDetailPage />} />
    </Routes>,
    { route: "/collections/c1" + hash },
  );
}

describe("CollectionDetailPage", () => {
  it("renders papers with full metadata instead of canonical keys", async () => {
    renderPage();

    expect(await screen.findByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.getByText("Ashish Vaswani")).toBeInTheDocument();
    expect(screen.getByText(/NeurIPS · 2017/)).toBeInTheDocument();
    // The raw canonical key must no longer be the visible label.
    expect(screen.queryByText("doi:10.1/attention")).toBeNull();
  });

  it("shows the collection header with translated metadata", async () => {
    renderPage();

    expect(await screen.findByText("Deep Learning Classics")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText(/1 paper ·/)).toBeInTheDocument();
  });

  it("exposes a reading-state selector on each paper row", async () => {
    renderPage();
    await screen.findByText("Attention Is All You Need");
    expect(screen.getByTestId("reading-state-select")).toBeInTheDocument();
  });
});


afterEach(() => { collection.revision = 1; collection.can_edit = true; collection.can_manage_access = true; collection.is_owner = true; focusManager.setFocused(undefined); });

it("offers no collection edits to authenticated readers", async () => {
  collection.can_edit = false; collection.can_manage_access = false; collection.is_owner = false;
  renderPage(); await screen.findByText("Attention Is All You Need");
  expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  expect(screen.queryByTitle("Edit collection")).toBeNull();
  expect(screen.queryByTitle("Remove from collection")).toBeNull();
  expect(screen.queryByRole("button", { name: "Import DOIs" })).toBeNull();
});

it("forwards the read capability only to scoped reads and preserves it for the graph", async () => {
  collection.can_edit = false; collection.can_manage_access = false; collection.is_owner = false;
  const token = "a".repeat(43);
  renderPage(false, "#share=" + token);
  await screen.findByText("Attention Is All You Need");
  expect(api.get).toHaveBeenCalledWith("/collections/c1", { headers: { "X-Collection-Share-Token": token } });
  expect(api.get).toHaveBeenCalledWith("/collections/c1/papers", { headers: { "X-Collection-Share-Token": token } });
  expect(screen.getByRole("link", { name: /View citation graph/i })).toHaveAttribute("href", "/graph/collection/c1#share=" + token);
  expect(localStorage.getItem("share")).toBeNull();
});

it("sends the current revision when saving metadata", async () => {
  vi.mocked(api.patch).mockResolvedValue({ data: {} });
  renderPage(); await screen.findByText("Deep Learning Classics");
  fireEvent.click(screen.getByTitle("Edit collection"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/collections/c1", { name: collection.name, description: collection.description, revision: 1 }));
});

it("removes displayed content on refocus after link revocation", async () => {
  renderPage(false, "#share=" + "a".repeat(43));
  await screen.findByText("Attention Is All You Need");
  const previous = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (url, config) => {
    if (url?.startsWith("/collections/")) throw { response: { status: 404 } };
    return previous(url, config);
  });
  focusManager.setFocused(false); focusManager.setFocused(true);
  expect(await screen.findByText("Collection unavailable or access no longer granted.")).toBeInTheDocument();
  expect(screen.queryByText("Attention Is All You Need")).toBeNull();
  vi.mocked(api.get).mockImplementation(previous);
});


it("keeps the editing revision even when a focus refresh discovers another writer", async () => {
  vi.mocked(api.patch).mockResolvedValue({ data: {} });
  renderPage(); await screen.findByText("Deep Learning Classics");
  fireEvent.click(screen.getByTitle("Edit collection"));
  collection.revision = 2;
  focusManager.setFocused(false); focusManager.setFocused(true);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith("/collections/c1", expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith("/collections/c1", { name: collection.name, description: collection.description, revision: 1 }));
});


it("waits for anonymous session hydration before starting protected reads", async () => {
  let rejectRefresh: (reason: Error) => void = () => {};
  vi.mocked(refreshAccessToken).mockReturnValueOnce(new Promise((_, reject) => { rejectRefresh = reject; }));
  const before = vi.mocked(api.get).mock.calls.filter(([url]) => url === "/collections/c1").length;
  renderPage(false, "#share=" + "a".repeat(43));
  expect(vi.mocked(api.get).mock.calls.filter(([url]) => url === "/collections/c1")).toHaveLength(before);
  await act(async () => { rejectRefresh(new Error("No session")); });
  expect(await screen.findByText("Attention Is All You Need")).toBeInTheDocument();
});
