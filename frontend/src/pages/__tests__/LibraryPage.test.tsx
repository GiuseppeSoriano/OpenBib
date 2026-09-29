import { mockRefresh } from "@/test/auth-mock";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import LibraryPage from "@/pages/LibraryPage";
import { library, papers } from "@/lib/api";
import { COMPACT_QUERY } from "@/lib/breakpoints";
import { renderWithProviders } from "@/test/utils";
import type { LibraryEntryListItem, LibraryListParams, PaperMetadata } from "@/types";

function paper(key: string, title: string): PaperMetadata {
  return {
    canonical_key: key,
    paper_group_key: `group:${key}`,
    title,
    authors: [{ name: "Alice Smith", openalex_id: null, orcid: null, affiliations: [] }],
    abstract: null,
    publication_date: "2020-01-01",
    doi: "10.1234/secret",
    arxiv_id: null,
    pmid: null,
    pmcid: null,
    openalex_id: null,
    venue: "ICML",
    volume: null,
    issue: null,
    pages: null,
    paper_type: null,
    topics: [],
    keywords: [],
    open_access: true,
    pdf_url: null,
    abstract_url: null,
    cited_by_count: 42,
    reference_count: null,
    version: null,
    provider_source: "openalex",
    provider_sources: ["openalex"],
  };
}

function entry(key: string, title: string, extra: Partial<LibraryEntryListItem> = {}) {
  return {
    paper_group_key: `group:${key}`,
    primary_canonical_key: key,
    created_at: "2026-01-01T00:00:00Z",
    primary_version: paper(key, title),
    resolved: true,
    version_count: 1,
    tags: [],
    ...extra,
  };
}

const COLLECTION_ID = "0b5f3c2e-8d4a-4c1b-9e7f-2a6d8c4b1e30";

const entries: LibraryEntryListItem[] = [
  entry("doi:10.1/a", "First Library Paper", { version_count: 2, tags: ["ml", "survey"] }),
  entry("doi:10.1/b", "Second Library Paper"),
];

function envelope(items: LibraryEntryListItem[], total = items.length, page = 1, size = 25) {
  return Promise.resolve({ items, total, page, size });
}

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn((url: string) =>
      Promise.resolve({
        data: url === "/collections" ? [{ id: COLLECTION_ID, name: "Reading group" }] : [],
      }),
    ),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  library: {
    listEntries: vi.fn(),
    getFacets: vi.fn(() =>
      Promise.resolve({
        tags: [
          { tag: "ml", count: 1 },
          { tag: "survey", count: 1 },
        ],
        states: [{ state: "reading", count: 1 }],
        total: 2,
        unresolved: 0,
      }),
    ),
    listKeys: vi.fn(() => Promise.resolve([])),
    getEntry: vi.fn(),
    deleteEntry: vi.fn(),
  },
  papers: {
    getDetail: vi.fn(() => Promise.resolve({ ...entries[0]!.primary_version, versions: [] })),
  },
  notes: { listForPaperGroup: vi.fn(() => Promise.resolve([])) },
  graph: {},
  zotero: {
    getStatus: vi.fn(() =>
      Promise.resolve({ connected: false, zotero_user_id: null, api_key_masked: null }),
    ),
    syncLibrary: vi.fn(),
  },
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function renderLibrary(route = "/library") {
  return renderWithProviders(
    <>
      <LibraryPage />
      <LocationProbe />
    </>,
    { route },
  );
}

const lastListParams = () =>
  vi.mocked(library.listEntries).mock.calls.slice(-1)[0]?.[0] as LibraryListParams;

beforeEach(() => {
  vi.mocked(library.listEntries).mockImplementation(() => envelope(entries));
});

afterEach(() => {
  vi.mocked(library.listEntries).mockReset();
  vi.mocked(library.getEntry).mockReset();
});

describe("LibraryPage", () => {
  it("renders rich human-readable entries", async () => {
    const { container } = renderLibrary();

    expect(await screen.findByText("First Library Paper")).toBeInTheDocument();
    expect(screen.getByText("Second Library Paper")).toBeInTheDocument();
    // The meta line may split the citation count into several elements.
    const meta = Array.from(container.querySelectorAll(".paper-meta"), (el) => el.textContent);
    expect(meta.filter((text) => /ICML · 2020 · 42 citations/.test(text ?? ""))).toHaveLength(2);
    expect(screen.getAllByText("ml").length).toBeGreaterThan(0);
    expect(screen.getByText("2 versions")).toBeInTheDocument();
    expect(screen.getByText("2 papers")).toBeInTheDocument();
  });

  it("describes the Library without internal wording", async () => {
    renderLibrary();
    const subtitle = await screen.findByText(/Every paper you save, in one place/);
    expect(subtitle.textContent).not.toMatch(/anchor|canonical/i);
  });

  it("exposes no low-level identifiers or accordion toggles", async () => {
    const { container } = renderLibrary();
    await screen.findByText("First Library Paper");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/doi:10\./);
    expect(text).not.toMatch(/hash:/);
    expect(text).not.toMatch(/10\.1234\/secret/);
    expect(screen.queryByText("View details")).toBeNull();
    expect(screen.queryByText("Hide details")).toBeNull();
    expect(container.querySelector("code")).toBeNull();
  });

  it("offers add-to-collection on every entry", async () => {
    renderLibrary();
    await screen.findByText("First Library Paper");
    expect(screen.getAllByTestId("add-to-collection")).toHaveLength(2);
  });

  it("keeps a minimal card for entries without metadata", async () => {
    vi.mocked(library.listEntries).mockImplementation(() =>
      envelope([entry("doi:10.1/x", "", { primary_version: null, resolved: false })]),
    );
    renderLibrary();
    expect(await screen.findByRole("button", { name: "Paper details" })).toBeInTheDocument();
  });

  it("opens the details panel when an entry is clicked", async () => {
    renderLibrary();
    fireEvent.click(await screen.findByText("First Library Paper"));
    expect(await screen.findByTestId("paper-details")).toBeInTheDocument();
  });

  it("loads the next page on Load more and appends it", async () => {
    const user = userEvent.setup();
    vi.mocked(library.listEntries).mockImplementation((params = {}) =>
      params.page === 2
        ? envelope([entry("doi:10.1/c", "Third Library Paper")], 3, 2, 2)
        : envelope(entries, 3, 1, 2),
    );
    renderLibrary();
    await screen.findByText("First Library Paper");
    expect(screen.getByText("Showing 2 of 3")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Third Library Paper")).toBeInTheDocument();
    expect(screen.getByText("First Library Paper")).toBeInTheDocument();
    expect(lastListParams()).toMatchObject({ page: 2, size: 25 });
    expect(screen.getByText("3 papers")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("opens a ?focus= entry that is not on the first page via getEntry", async () => {
    vi.mocked(library.getEntry).mockResolvedValue({
      paper_group_key: "group:far",
      primary_canonical_key: "doi:10.1/far",
      created_at: "2025-01-01T00:00:00Z",
      primary_version: paper("doi:10.1/far", "Far Away Paper"),
      pinned_versions: [],
      notes_count: 0,
      tags: [],
      states: [],
    });
    renderLibrary("/library?focus=group%3Afar");

    expect(await screen.findByTestId("paper-details")).toBeInTheDocument();
    expect(library.getEntry).toHaveBeenCalledWith("group:far");
    expect(papers.getDetail).toHaveBeenCalledWith("doi:10.1/far");
    // Resolved directly, not by paging through the list.
    expect(library.listEntries).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the details dialog and back to the title on Escape", async () => {
    const user = userEvent.setup();
    renderLibrary();
    const title = await screen.findByRole("button", { name: "First Library Paper" });

    await user.click(title);
    const dialog = await screen.findByRole("dialog", { name: /Paper details/ });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(title);
  });

  it("closes a ?focus= deep-linked panel without a trigger, focusing the page heading", async () => {
    const user = userEvent.setup();
    vi.mocked(library.getEntry).mockResolvedValue({
      ...entries[1]!,
      pinned_versions: [],
      notes_count: 0,
      states: [],
    });
    renderLibrary("/library?focus=group%3Adoi%3A10.1%2Fb");
    await screen.findByTestId("paper-details");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Library" }));
  });
});

describe("LibraryPage filters", () => {
  it("syncs a debounced search to the URL and the query", async () => {
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("First Library Paper");

    await user.type(screen.getByRole("searchbox", { name: "Search your Library" }), "graph nets");

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("?q=graph+nets"));
    await waitFor(() => expect(lastListParams()).toMatchObject({ q: "graph nets", page: 1 }));
    // Debounced: one request for the whole phrase, none per keystroke.
    expect(vi.mocked(library.listEntries).mock.calls).toHaveLength(2);
  });

  it("applies state, tag, collection and sort from the selects", async () => {
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("First Library Paper");

    await user.selectOptions(screen.getByLabelText("Reading state"), "reading");
    await user.selectOptions(await screen.findByLabelText("Tag"), "ml");
    await user.selectOptions(await screen.findByLabelText("Collection"), COLLECTION_ID);
    await user.selectOptions(screen.getByLabelText("Sort by"), "citations");

    await waitFor(() =>
      expect(lastListParams()).toMatchObject({
        state: "reading",
        tag: "ml",
        collection_id: COLLECTION_ID,
        sort: "citations",
      }),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      `?state=reading&tag=ml&collection_id=${COLLECTION_ID}&sort=citations`,
    );
    expect(screen.getByText("3 filters active")).toBeInTheDocument();
    // Facet counts label the options.
    expect(screen.getByRole("option", { name: "ml (1)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Reading group" })).toBeInTheDocument();
  });

  it("reads filters from the URL and resets them", async () => {
    const user = userEvent.setup();
    renderLibrary("/library?q=graph&state=reading&sort=title");
    await screen.findByText("First Library Paper");

    expect(lastListParams()).toMatchObject({ q: "graph", state: "reading", sort: "title" });
    expect(screen.getByRole("searchbox")).toHaveValue("graph");
    expect(screen.getByText("2 filters active")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset filters" }));

    await waitFor(() => expect(screen.getByTestId("location")).toBeEmptyDOMElement());
    expect(screen.getByRole("searchbox")).toHaveValue("");
    await waitFor(() => expect(lastListParams()).toEqual({ page: 1, size: 25 }));
  });

  it("shows a no-matches state with a reset when filters exclude everything", async () => {
    const user = userEvent.setup();
    vi.mocked(library.listEntries).mockImplementation((params = {}) =>
      params.q ? envelope([], 0) : envelope(entries),
    );
    renderLibrary("/library?q=nothing");

    expect(await screen.findByText("No papers match these filters")).toBeInTheDocument();
    expect(screen.queryByText("Your library is empty")).toBeNull();

    const empty = screen.getByTestId("empty-state");
    await user.click(within(empty).getByRole("button", { name: "Reset filters" }));

    expect(await screen.findByText("First Library Paper")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toBeEmptyDOMElement();
  });

  it("offers the reset when the filtered collection is no longer viewable", async () => {
    const goneId = "5d0e9a41-7c3b-4f2a-8e6d-1b9c0a7f3e52";
    vi.mocked(library.listEntries).mockImplementation((params = {}) =>
      params.collection_id
        ? Promise.reject({ response: { status: 404, data: { detail: "Collection not found" } } })
        : envelope(entries),
    );
    renderLibrary(`/library?collection_id=${goneId}`);

    expect(await screen.findByText("No papers match these filters")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Selected collection" })).toBeInTheDocument();
  });

  it("offers the reset when the API rejects a filter value", async () => {
    vi.mocked(library.listEntries).mockImplementation((params = {}) =>
      params.tag
        ? Promise.reject({ response: { status: 422, data: { detail: "Invalid tag" } } })
        : envelope(entries),
    );
    renderLibrary("/library?tag=ml");

    expect(await screen.findByText("No papers match these filters")).toBeInTheDocument();
    expect(screen.queryByText("Couldn’t load your Library.")).toBeNull();
  });

  it("ignores a malformed collection id in the URL", async () => {
    renderLibrary("/library?collection_id=gone");

    expect(await screen.findByText("First Library Paper")).toBeInTheDocument();
    expect(lastListParams()).toEqual({ page: 1, size: 25 });
    expect(screen.queryByText(/filters? active/)).toBeNull();
  });

  it("shows an error with a retry when the list fails to load", async () => {
    const user = userEvent.setup();
    vi.mocked(library.listEntries).mockImplementationOnce(() =>
      Promise.reject({ response: { status: 503 } }),
    );
    renderLibrary();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Couldn’t load your Library.")).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("First Library Paper")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hides the reading-state filter when no entry has a state", async () => {
    vi.mocked(library.getFacets).mockResolvedValueOnce({
      tags: [],
      states: [],
      total: 2,
      unresolved: 0,
    });
    renderLibrary();
    await screen.findByText("First Library Paper");

    await waitFor(() => expect(screen.queryByLabelText("Reading state")).toBeNull());
    expect(screen.getByLabelText("Sort by")).toBeInTheDocument();
  });

  it("folds the filters behind a toggle on compact screens", async () => {
    const user = userEvent.setup();
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query === COMPACT_QUERY,
    })) as typeof window.matchMedia;
    try {
      renderLibrary("/library?state=reading");
      await screen.findByText("First Library Paper");

      const toggle = screen.getByRole("button", { name: /Filters/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveTextContent("1");
      expect(screen.getByLabelText("Reading state")).not.toBeVisible();

      await user.click(toggle);

      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByLabelText("Reading state")).toBeVisible();
    } finally {
      window.matchMedia = original;
    }
  });
});
