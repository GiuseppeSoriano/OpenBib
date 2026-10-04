import api, { refreshAccessToken } from "@/lib/api";
import { focusManager } from "@tanstack/react-query";
import { testAuth, mockRefresh } from "@/test/auth-mock";
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Routes, Route, useLocation, useNavigationType } from "react-router-dom";
import CollectionDetailPage from "@/pages/CollectionDetailPage";
import { renderWithProviders } from "@/test/utils";
import userEvent from "@testing-library/user-event";
import { library, papers as paperApi } from "@/lib/api";

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

// Rows the papers endpoint answers with; tests swap it and afterEach restores it.
const paperRows: { current: unknown[] } = { current: [hydratedRow] };

vi.mock("@/lib/api", () => {
  const get = vi.fn((url: string) => {
    if (url === "/users/me")
      return Promise.resolve({
        data: { id: "u1", email: "me@example.com", display_name: "Me", created_at: "2026-01-01" },
      });
    if (url === "/collections/c1") return Promise.resolve({ data: collection });
    if (url === "/collections/c1/papers") return Promise.resolve({ data: paperRows.current });
    return Promise.resolve({ data: [] });
  });
  return {
    refreshAccessToken: vi.fn(() => mockRefresh()),
    setAccessToken: vi.fn(),
    setAuthFailureHandler: vi.fn(),
    default: { get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
    papers: {
      getStates: vi.fn(() => Promise.resolve([])),
      getTags: vi.fn(() => Promise.resolve([])),
      setState: vi.fn(),
      getDetail: vi.fn(() => Promise.resolve({ ...hydratedRow.paper, versions: [] })),
    },
    library: { listKeys: vi.fn(() => Promise.resolve([])), resolve: vi.fn() },
    notes: { listForPaperGroup: vi.fn(() => Promise.resolve([])) },
    graph: {},
    zotero: {
      getStatus: vi.fn(() =>
        Promise.resolve({ connected: false, zotero_user_id: null, api_key_masked: null }),
      ),
    },
  };
});

function LocationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <output data-testid="location" data-navigation={navigationType}>
      {location.pathname + location.search + location.hash}
    </output>
  );
}

function renderPage(authenticated = true, hash = "", search = "") {
  // Simulate an authenticated session: AuthProvider hydrates from /users/me.
  testAuth.authenticated = authenticated;
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/collections/:id" element={<CollectionDetailPage />} />
        <Route path="/search" element={<p>Search page</p>} />
      </Routes>
      <LocationProbe />
    </>,
    { route: "/collections/c1" + search + hash },
  );
}

describe("CollectionDetailPage", () => {
  it("renders papers with full metadata instead of canonical keys", async () => {
    renderPage();

    expect(await screen.findByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.getByText("Ashish Vaswani")).toBeInTheDocument();
    // The row sets the venue in italics, so the meta line spans several elements.
    expect(document.querySelector(".paper-meta")).toHaveTextContent(/NeurIPS · 2017/);
    // The raw canonical key must no longer be the visible label.
    expect(screen.queryByText("doi:10.1/attention")).toBeNull();
  });

  it("shows the collection header with translated metadata", async () => {
    renderPage();

    expect(await screen.findByText("Deep Learning Classics")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText(/1 paper ·/)).toBeInTheDocument();
  });

  it("lists the papers as rows under a section heading and folds notes behind a disclosure", async () => {
    renderPage();
    await screen.findByText("Attention Is All You Need");

    expect(screen.getByText("Collection").closest(".page-header-eyebrow")).not.toBeNull();
    const papers = screen.getByRole("region", { name: "Papers" });
    expect(within(papers).getAllByRole("listitem").filter((li) => li.classList.contains("list-row"))).toHaveLength(1);
    expect(within(papers).getByText("1 paper")).toBeInTheDocument();

    const notes = screen.getByRole("button", { name: "Notes" });
    expect(notes.closest("h2")).not.toBeNull();
    expect(notes).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(notes);
    expect(notes).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Notes" })).toBeInTheDocument();
  });

  it("exposes a reading-state selector on each paper row", async () => {
    renderPage();
    await screen.findByText("Attention Is All You Need");
    expect(screen.getByRole("button", { name: "Reading state: No state" })).toHaveAttribute(
      "data-testid",
      "reading-state-select",
    );
  });
});


afterEach(() => { collection.revision = 1; collection.can_edit = true; collection.can_manage_access = true; collection.is_owner = true; paperRows.current = [hydratedRow]; vi.mocked(api.post).mockReset(); focusManager.setFocused(undefined); });

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

describe("CollectionDetailPage — adding papers", () => {
  it("has no single-DOI field; editors get Add papers, which opens Search", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Attention Is All You Need");
    expect(screen.queryByLabelText("DOI to add")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add paper" })).toBeNull();

    const add = screen.getByRole("link", { name: "Add papers" });
    expect(add).toHaveAttribute("href", "/search");
    await user.click(add);
    expect(await screen.findByText("Search page")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/search$/);
  });

  it("keeps Import DOIs in the More actions menu and returns focus to it", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Attention Is All You Need");
    expect(screen.queryByRole("button", { name: "Import DOIs" })).toBeNull();

    const more = screen.getByRole("button", { name: "More actions" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Import DOIs" }));
    const dialog = await screen.findByRole("dialog", { name: "Import DOIs" });
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(more).toHaveFocus();
  });

  it("shows readers no add, import or remove controls", async () => {
    collection.can_edit = false; collection.can_manage_access = false; collection.is_owner = false;
    renderPage();
    await screen.findByText("Attention Is All You Need");
    expect(screen.queryByRole("link", { name: "Add papers" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove from collection/ })).toBeNull();
  });
});

const residualRow = {
  ...hydratedRow,
  paper_canonical_key: "doi:10.1/resnet",
  paper_group_key: "group:resnet",
  position: 1,
  added_at: "2026-03-01T10:00:00Z",
  paper: {
    ...hydratedRow.paper,
    canonical_key: "doi:10.1/resnet",
    paper_group_key: "group:resnet",
    title: "Deep Residual Learning",
    authors: [{ name: "Kaiming He", openalex_id: null, orcid: null, affiliations: [] }],
    publication_date: "2016-06-27",
    venue: "CVPR",
    cited_by_count: 200000,
  },
};

const godelRow = {
  ...hydratedRow,
  paper_canonical_key: "doi:10.1/godel",
  paper_group_key: "group:godel",
  position: 2,
  added_at: "2026-01-10T10:00:00Z",
  paper: {
    ...hydratedRow.paper,
    canonical_key: "doi:10.1/godel",
    paper_group_key: "group:godel",
    title: "Gödel Machines",
    authors: [{ name: "Jürgen Schmidhuber", openalex_id: null, orcid: null, affiliations: [] }],
    publication_date: "2003-09-01",
    venue: null,
    cited_by_count: 50,
  },
};

function annotated<T extends { paper_canonical_key: string }>(row: T, state: string | null, tags: string[]) {
  const key = row.paper_canonical_key;
  return {
    ...row,
    my_states: state ? [{ paper_canonical_key: key, state }] : [],
    my_tags: tags.map((tag) => ({ paper_canonical_key: key, tag, paper_group_key: null, created_at: "2026-01-01" })),
  };
}

function filterRows() {
  return [
    annotated(hydratedRow, "reading", ["seminal"]),
    annotated(residualRow, "read", ["vision"]),
    annotated(godelRow, null, ["seminal"]),
    annotated({ ...pendingRow, position: 3 }, null, []),
  ];
}

/** The rows on screen, in order: a title, or the unresolved row's marker. */
function rowLabels() {
  const list = document.querySelector(".cd-paper-list");
  if (!list) return [];
  return Array.from(list.querySelectorAll(":scope > li")).map((li) =>
    li.querySelector(".unresolved-card") ? "unresolved" : (li.querySelector(".paper-title")?.textContent ?? "").trim(),
  );
}

function importResult(lines: [string, string, (string | null)?][]) {
  const results = lines.map(([input, status, title], index) => ({
    line: index + 1, input, status, canonical_key: null, title: title ?? null,
  }));
  const count = (status: string) => results.filter((r) => r.status === status).length;
  return {
    data: {
      added: count("added"), duplicate: count("duplicate"), invalid: count("invalid"),
      not_found: count("not_found"), unresolved: count("unresolved"), total: results.length,
      skipped: count("duplicate"), results,
    },
  };
}

async function openImport(text: string) {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole("button", { name: "More actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Import DOIs" }));
  const dialog = await screen.findByRole("dialog", { name: "Import DOIs" });
  const textarea = within(dialog).getByLabelText("DOIs, DOI links or arXiv IDs, one per line");
  fireEvent.change(textarea, { target: { value: text } });
  return { user, dialog };
}

describe("CollectionDetailPage — import", () => {
  it("summarizes the paste live and blocks an import with nothing valid", async () => {
    const { dialog } = await openImport("not-a-doi");
    expect(within(dialog).getByText(/0 valid · 1 invalid/)).toBeInTheDocument();
    expect(within(dialog).getByText("Line 1: “not-a-doi” isn’t a DOI or arXiv ID")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import 0 DOIs" })).toBeDisabled();
  });

  it("counts distinct valid identifiers and reports every line until Done", async () => {
    vi.mocked(api.post).mockResolvedValue(
      importResult([["10.1/a", "added", "Paper A"], ["arxiv:2306.00001", "not_found"]]),
    );
    const { user, dialog } = await openImport("10.1/a\nnot-a-doi\nhttps://doi.org/10.1/A\narxiv:2306.00001");
    expect(within(dialog).getByText(/3 valid · 1 invalid/)).toHaveTextContent("1 repeated line will be imported once.");

    await user.click(within(dialog).getByRole("button", { name: "Import 2 DOIs" }));

    expect(api.post).toHaveBeenCalledWith("/collections/c1/import/dois", { dois: ["10.1/a", "arxiv:2306.00001"] });
    const results = await within(dialog).findByRole("list");
    const items = within(results).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Line 110.1/aAddedPaper A",
      "Line 2not-a-doiNot a valid identifier",
      "Line 3https://doi.org/10.1/ARepeated — see line 1",
      "Line 4arxiv:2306.00001Not found",
    ]);
    expect(await screen.findByText("1 added, 0 pending, 0 already present, 2 not imported")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Import DOIs" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sends chunks of 25 and retries only the lines the provider could not answer", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `10.1/p${i}`);
    vi.mocked(api.post).mockImplementation(async (_url, body) => {
      const dois = (body as { dois: string[] }).dois;
      return importResult(dois.map((doi) => [doi, doi === "10.1/p27" ? "unavailable" : "added"]));
    });
    const { user, dialog } = await openImport(lines.join("\n"));
    await user.click(within(dialog).getByRole("button", { name: "Import 30 DOIs" }));

    await within(dialog).findByRole("button", { name: "Retry 1 line" });
    const calls = vi.mocked(api.post).mock.calls.map(([, body]) => (body as { dois: string[] }).dois.length);
    expect(calls).toEqual([25, 5]);
    expect(within(dialog).getByText("Semantic Scholar unavailable — not added")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Retry 1 line" }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith("/collections/c1/import/dois", { dois: ["10.1/p27"] }));
  });

  it("stops on lost access and keeps the lines already imported", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `10.1/q${i}`);
    vi.mocked(api.post)
      .mockImplementationOnce(async (_url, body) =>
        importResult((body as { dois: string[] }).dois.map((doi) => [doi, "added"])),
      )
      .mockRejectedValueOnce({ response: { status: 403 } });
    const { user, dialog } = await openImport(lines.join("\n"));
    await user.click(within(dialog).getByRole("button", { name: "Import 30 DOIs" }));

    expect(await within(dialog).findByText("Import stopped: you can no longer edit this collection.")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Added")).toHaveLength(25);
    expect(within(dialog).getAllByText("Not sent — try again")).toHaveLength(5);
    expect(within(dialog).queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it("keeps the report open when the re-check finds the collection gone", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `10.1/r${i}`);
    const previous = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.post)
      .mockImplementationOnce(async (_url, body) =>
        importResult((body as { dois: string[] }).dois.map((doi) => [doi, "added"])),
      )
      .mockImplementationOnce(async () => {
        // The editor was removed mid-import: the page's re-check now gets a 404.
        vi.mocked(api.get).mockImplementation(async (url, config) => {
          if (url?.startsWith("/collections/c1")) throw { response: { status: 404 } };
          return previous(url, config);
        });
        throw { response: { status: 403 } };
      });
    try {
      const { user, dialog } = await openImport(lines.join("\n"));
      await user.click(within(dialog).getByRole("button", { name: "Import 30 DOIs" }));

      expect(await screen.findByText("Collection unavailable or access no longer granted.", { selector: ".empty-state-title" })).toBeInTheDocument();
      const report = screen.getByRole("dialog", { name: "Import DOIs" });
      expect(within(report).getByText("Import stopped: you can no longer edit this collection.")).toBeInTheDocument();
      expect(within(report).getAllByText("Added")).toHaveLength(25);
      expect(within(report).getAllByText("Not sent — try again")).toHaveLength(5);

      await user.click(within(report).getByRole("button", { name: "Done" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      vi.mocked(api.get).mockImplementation(previous);
    }
  });
});

const pendingRow = {
  paper_canonical_key: "10.1109/TNN.2008.2005605",
  paper_group_key: "group:0123456789abcdef",
  position: 1,
  added_at: "2026-02-02T10:00:00Z",
  paper: null,
  resolved: false,
};

describe("CollectionDetailPage — unresolved papers", () => {
  it("offers editors Retry, Fix and Remove instead of the graph", async () => {
    const user = userEvent.setup();
    paperRows.current = [pendingRow];
    vi.mocked(library.resolve).mockResolvedValue({
      status: "unavailable", previous_key: pendingRow.paper_canonical_key,
      canonical_key: pendingRow.paper_canonical_key, paper_group_key: null, paper: null, moved: {},
    });
    renderPage();

    const card = (await screen.findByRole("button", { name: "Details unavailable" })).closest("article")!;
    expect(within(card).getByRole("link", { name: /10\.1109\/tnn\.2008\.2005605/ })).toHaveAttribute(
      "href",
      "https://doi.org/10.1109/tnn.2008.2005605",
    );
    expect(within(card).queryByRole("link", { name: /Explore graph/ })).toBeNull();
    expect(within(card).queryByTestId("reading-state-select")).toBeNull();
    expect(within(card).getByRole("button", { name: "Fix identifier" })).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Try again" }));
    expect(library.resolve).toHaveBeenCalledWith({ paper_canonical_key: pendingRow.paper_canonical_key, replacement: null });

    await user.click(within(card).getByRole("button", { name: /Remove/ }));
    expect(await screen.findByRole("dialog", { name: "Remove paper" })).toHaveTextContent("Remove \"this paper\"");
  });

  it("moves focus to the heading when a retry replaces the row", async () => {
    const user = userEvent.setup();
    paperRows.current = [pendingRow];
    vi.mocked(library.resolve).mockResolvedValue({
      status: "resolved", previous_key: pendingRow.paper_canonical_key,
      canonical_key: "doi:10.1109/tnn.2008.2005605", paper_group_key: "group:tnn", paper: null, moved: {},
    });
    renderPage();

    const card = (await screen.findByRole("button", { name: "Details unavailable" })).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Deep Learning Classics" })).toHaveFocus());
  });

  it("shows readers the identifier without recovery actions", async () => {
    collection.can_edit = false; collection.can_manage_access = false; collection.is_owner = false;
    paperRows.current = [pendingRow];
    renderPage();

    const card = (await screen.findByRole("button", { name: "Details unavailable" })).closest("article")!;
    expect(within(card).getByText(/^DOI/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Fix identifier" })).toBeNull();
    expect(within(card).queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("re-resolves an opened unresolved row for editors only", async () => {
    const user = userEvent.setup();
    paperRows.current = [pendingRow];
    vi.mocked(library.resolve).mockClear();
    vi.mocked(library.resolve).mockResolvedValue({
      status: "resolved", previous_key: pendingRow.paper_canonical_key,
      canonical_key: "doi:10.1/attention", paper_group_key: "group:attention", paper: null, moved: {},
    });
    const { unmount } = renderPage();
    await user.click(await screen.findByRole("button", { name: "Details unavailable" }));
    await screen.findByTestId("paper-details");
    await waitFor(() =>
      expect(library.resolve).toHaveBeenCalledWith({ paper_canonical_key: pendingRow.paper_canonical_key }),
    );
    unmount();

    vi.mocked(library.resolve).mockClear();
    collection.can_edit = false; collection.can_manage_access = false; collection.is_owner = false;
    renderPage(false, "#share=" + "a".repeat(43));
    await user.click(await screen.findByRole("button", { name: "Details unavailable" }));
    await screen.findByTestId("paper-details");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(library.resolve).not.toHaveBeenCalled();
  });
});

it("reads each row's reading state and tags from the list response, not per-row requests", async () => {
  const rows = Array.from({ length: 30 }, (_, index) => {
    const key = `doi:10.1/row${index}`;
    return {
      ...hydratedRow,
      paper_canonical_key: key,
      position: index,
      paper: { ...hydratedRow.paper, canonical_key: key, title: `Row paper ${index}` },
      my_states: index === 3 ? [{ paper_canonical_key: key, state: "reading" }] : [],
      my_tags: index === 3 ? [{ paper_canonical_key: key, tag: "seminal", paper_group_key: null, created_at: "2026-01-01" }] : [],
    };
  });
  paperRows.current = rows;
  vi.mocked(paperApi.getStates).mockClear();
  vi.mocked(paperApi.getTags).mockClear();
  vi.mocked(api.get).mockClear();
  renderPage();

  await screen.findByText("Row paper 29");
  const selects = screen.getAllByTestId("reading-state-select");
  expect(selects).toHaveLength(30);
  expect(selects[3]).toHaveAccessibleName("Reading state: Reading");
  expect(selects[3]).toHaveAttribute("data-state", "reading");
  expect(selects[0]).toHaveAccessibleName("Reading state: No state");
  expect(selects[0]).toHaveAttribute("data-state", "none");
  expect(screen.getByText("seminal")).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(paperApi.getStates).not.toHaveBeenCalled();
  expect(paperApi.getTags).not.toHaveBeenCalled();
  const perRow = vi.mocked(api.get).mock.calls.filter(([url]) => /^\/papers\//.test(String(url)));
  expect(perRow).toEqual([]);

  // A focus refetch re-reads the list once and still sends no per-row requests.
  act(() => focusManager.setFocused(false));
  act(() => focusManager.setFocused(true));
  await waitFor(() =>
    expect(vi.mocked(api.get).mock.calls.filter(([url]) => url === "/collections/c1/papers").length).toBeGreaterThan(1),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(paperApi.getStates).not.toHaveBeenCalled();
  expect(paperApi.getTags).not.toHaveBeenCalled();
});

it("keeps a state saved while a list refetch was in flight, and still takes newer list data", async () => {
  const key = hydratedRow.paper_canonical_key;
  const row = (state: string | null) => ({
    ...hydratedRow,
    my_states: state ? [{ paper_canonical_key: key, state }] : [],
    my_tags: [],
  });
  paperRows.current = [row(null)];
  vi.mocked(paperApi.getStates).mockClear();
  renderPage();
  const select = await screen.findByTestId("reading-state-select");
  expect(select).toHaveAttribute("data-state", "none");

  const previous = vi.mocked(api.get).getMockImplementation()!;
  let releaseList: (() => void) | undefined;
  vi.mocked(api.get).mockImplementation((url, config) => {
    if (url === "/collections/c1/papers")
      return new Promise((resolve) => { releaseList = () => resolve({ data: [row(null)] }); });
    return previous(url, config);
  });
  try {
    // The list request starts, then the reader saves a state before it answers.
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(releaseList).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 5));
    vi.mocked(paperApi.setState).mockResolvedValue({ paper_canonical_key: key, state: "read" });
    const user = userEvent.setup();
    await user.click(select);
    await user.click(screen.getByRole("option", { name: "Read" }));
    await waitFor(() => expect(select).toHaveAttribute("data-state", "read"));
    await waitFor(() => expect(select).not.toHaveAttribute("aria-disabled"));

    // The older list response must not put the pre-save state back.
    await act(async () => { releaseList!(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("reading-state-select")).toHaveAccessibleName("Reading state: Read");
  } finally {
    vi.mocked(api.get).mockImplementation(previous);
  }

  // A list request started after the save carries newer data and still seeds the row.
  await new Promise((resolve) => setTimeout(resolve, 5));
  paperRows.current = [row("important")];
  act(() => focusManager.setFocused(false));
  act(() => focusManager.setFocused(true));
  await waitFor(() =>
    expect(screen.getByTestId("reading-state-select")).toHaveAccessibleName("Reading state: Important"),
  );
  expect(paperApi.getStates).not.toHaveBeenCalled();
});

describe("CollectionDetailPage — filters", () => {
  it("filters on title, authors and venue as the reader types, replacing the history entry", async () => {
    const user = userEvent.setup();
    paperRows.current = filterRows();
    renderPage();
    await screen.findByText("Deep Residual Learning");
    expect(rowLabels()).toEqual(["Attention Is All You Need", "Deep Residual Learning", "Gödel Machines", "unresolved"]);
    expect(document.querySelector(".cd-filter-status")).toHaveTextContent(/^$/);

    const field = screen.getByRole("searchbox", { name: "Filter this collection" });
    await user.type(field, "cvpr");
    await waitFor(() => expect(rowLabels()).toEqual(["Deep Residual Learning"]));
    expect(screen.getByText("Showing 1 of 4 papers")).toHaveAttribute("role", "status");
    expect(screen.getByTestId("location")).toHaveTextContent("/collections/c1?q=cvpr");
    expect(screen.getByTestId("location")).toHaveAttribute("data-navigation", "REPLACE");

    // Authors match without their accents; the clear button empties the filter.
    await user.clear(field);
    await user.type(field, "jurgen");
    await waitFor(() => expect(rowLabels()).toEqual(["Gödel Machines"]));
    await user.click(screen.getByRole("button", { name: "Clear search text" }));
    await waitFor(() => expect(rowLabels()).toHaveLength(4));
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
  });

  it("matches an unresolved row on its identifier", async () => {
    const user = userEvent.setup();
    paperRows.current = filterRows();
    renderPage();
    await user.type(await screen.findByRole("searchbox", { name: "Filter this collection" }), "tnn.2008");
    await waitFor(() => expect(rowLabels()).toEqual(["unresolved"]));
    expect(screen.getByRole("button", { name: "Details unavailable" })).toBeInTheDocument();
  });

  it("filters by the reader's own reading state and tag", async () => {
    const user = userEvent.setup();
    paperRows.current = filterRows();
    renderPage();
    await screen.findByText("Deep Residual Learning");

    await user.click(screen.getByRole("button", { name: "Reading state" }));
    expect(screen.getByRole("option", { name: "Read (1)" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Reading (1)" }));
    await waitFor(() => expect(rowLabels()).toEqual(["Attention Is All You Need"]));
    expect(screen.getByTestId("location")).toHaveTextContent("/collections/c1?state=reading");
    const filters = screen.getByRole("region", { name: "Filters" });
    expect(within(filters).getByRole("button", { name: "Reading state: Reading" })).toBeInTheDocument();

    await user.click(within(filters).getByRole("button", { name: "Reading state: Reading" }));
    await user.click(screen.getByRole("option", { name: "Any state" }));
    await user.click(screen.getByRole("button", { name: "Tag" }));
    await user.click(screen.getByRole("option", { name: "seminal (2)" }));
    await waitFor(() => expect(rowLabels()).toEqual(["Attention Is All You Need", "Gödel Machines"]));
    expect(screen.getByText("Showing 2 of 4 papers")).toBeInTheDocument();
    expect(screen.getByText("1 filter active")).toBeInTheDocument();
  });

  it("drops a row from a state filter as soon as its state changes", async () => {
    const user = userEvent.setup();
    paperRows.current = filterRows();
    vi.mocked(paperApi.setState).mockResolvedValue({ paper_canonical_key: hydratedRow.paper_canonical_key, state: "read" });
    renderPage(true, "", "?state=reading");
    await waitFor(() => expect(rowLabels()).toEqual(["Attention Is All You Need"]));
    await user.click(screen.getByTestId("reading-state-select"));
    await user.click(screen.getByRole("option", { name: "Read" }));
    expect(await screen.findByText("No papers match these filters")).toBeInTheDocument();
    // The focused row left the list: focus goes to Reset, not to the page body.
    const empty = screen.getByText("No papers match these filters").closest(".empty-state") as HTMLElement;
    await waitFor(() => expect(within(empty).getByRole("button", { name: "Reset filters" })).toHaveFocus());
  });

  it("keeps focus in the page when a focused row leaves a list that still has matches", async () => {
    const user = userEvent.setup();
    paperRows.current = [
      annotated(hydratedRow, "reading", []),
      annotated(residualRow, "reading", []),
      annotated(godelRow, "reading", []),
      annotated({ ...pendingRow, position: 3 }, null, []),
    ];
    vi.mocked(paperApi.setState).mockResolvedValue({ paper_canonical_key: hydratedRow.paper_canonical_key, state: "read" });
    renderPage(true, "", "?state=reading");
    await waitFor(() => expect(rowLabels()).toHaveLength(3));
    const row = screen.getByText("Attention Is All You Need").closest("li") as HTMLElement;
    await user.click(within(row).getByTestId("reading-state-select"));
    await user.click(within(row).getByRole("option", { name: "Read" }));
    await waitFor(() => expect(rowLabels()).toHaveLength(2));
    await waitFor(() => expect(screen.getByText("Showing 2 of 4 papers")).toHaveFocus());
  });

  it.each([
    ["Title (A–Z)", "title", ["Attention Is All You Need", "Deep Residual Learning", "Gödel Machines", "unresolved"]],
    ["Most cited", "citations", ["Deep Residual Learning", "Attention Is All You Need", "Gödel Machines", "unresolved"]],
    ["Year (newest first)", "year", ["Attention Is All You Need", "Deep Residual Learning", "Gödel Machines", "unresolved"]],
    ["Recently added", "added", ["Deep Residual Learning", "unresolved", "Attention Is All You Need", "Gödel Machines"]],
  ])("sorts by %s", async (label, sort, order) => {
    const user = userEvent.setup();
    paperRows.current = filterRows();
    renderPage();
    await screen.findByText("Deep Residual Learning");
    await user.click(screen.getByRole("button", { name: "Sort by Collection order" }));
    await user.click(screen.getByRole("option", { name: label }));
    await waitFor(() => expect(rowLabels()).toEqual(order));
    expect(screen.getByTestId("location")).toHaveTextContent(`/collections/c1?sort=${sort}`);
  });

  it("reads the filters from the URL and resets them from the empty state", async () => {
    const user = userEvent.setup();
    paperRows.current = filterRows();
    renderPage(true, "", "?q=nothing-matches&sort=title");
    expect(await screen.findByText("No papers match these filters")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Filter this collection" })).toHaveValue("nothing-matches");
    expect(screen.getByText("Showing 0 of 4 papers")).toBeInTheDocument();

    const empty = screen.getByText("No papers match these filters").closest(".empty-state") as HTMLElement;
    await user.click(within(empty).getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(rowLabels()).toHaveLength(4));
    expect(screen.getByTestId("location").textContent).toBe("/collections/c1");
    expect(screen.getByRole("searchbox", { name: "Filter this collection" })).toHaveValue("");
  });

  it("gives an anonymous read-link viewer text and sort only, keeping the link's fragment", async () => {
    const user = userEvent.setup();
    collection.can_edit = false; collection.can_manage_access = false; collection.is_owner = false;
    paperRows.current = filterRows().map((row) => ({ ...row, my_states: null, my_tags: null }));
    const share = "#share=" + "a".repeat(43);
    renderPage(false, share, "?state=reading&tag=seminal");
    await screen.findByText("Deep Residual Learning");
    // State and tag in the URL do not apply without an account.
    expect(rowLabels()).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /Reading state/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Tag/ })).toBeNull();

    await user.type(screen.getByRole("searchbox", { name: "Filter this collection" }), "attention");
    await waitFor(() => expect(rowLabels()).toEqual(["Attention Is All You Need"]));
    await user.click(screen.getByRole("button", { name: "Sort by Collection order" }));
    await user.click(screen.getByRole("option", { name: "Most cited" }));
    // Filters that do not apply leave the URL; the read link's fragment stays.
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(`/collections/c1?q=attention&sort=citations${share}`),
    );
    expect(rowLabels()).toEqual(["Attention Is All You Need"]);
  });
});
