import { mockRefresh, testAuth } from "@/test/auth-mock";
import { StrictMode, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SearchPage from "@/pages/SearchPage";
import TopNav from "@/components/nav/TopNav";
import MobileTabBar from "@/components/nav/MobileTabBar";
import api, { papers } from "@/lib/api";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ToastProvider } from "@/components/ui/Toast";
import { clearLastSearch, getLastSearch, setLastSearch } from "@/lib/lastSearch";
import { clearScrollPositions } from "@/hooks/useScrollRestore";
import { resultElementId } from "@/lib/search-pages";
import { mockMatchMedia, renderWithProviders, restoreMatchMedia } from "@/test/utils";
import { COMPACT_QUERY } from "@/lib/breakpoints";
import type { PaperMetadata, SearchParams, SearchResult, SearchResultItem } from "@/types";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  papers: { search: vi.fn(), getDetail: vi.fn() },
  library: { listKeys: vi.fn(() => Promise.resolve([])) },
  notes: {},
  graph: {},
  zotero: {},
}));

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
    provider_source: "semantic_scholar",
    provider_sources: ["semantic_scholar"],
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

const baseItems: SearchResultItem[] = [
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
];

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    items: baseItems,
    total_count: 2,
    raw_total_count: 3,
    has_more: false,
    page: 1,
    page_size: 20,
    providers: ["semantic_scholar"],
    sort: "relevance",
    next_cursor: null,
    total_estimate: 1234,
    window_capped: false,
    filtered_locally: false,
    source: "semantic_scholar",
    ...overrides,
  };
}

function providerError(status: number, code: string, headers: Record<string, string> = {}) {
  return Object.assign(new Error(code), {
    isAxiosError: true,
    response: { status, data: { detail: { code, message: "server text" } }, headers },
  });
}

const search = vi.mocked(papers.search);
const searchCalls = () => search.mock.calls.map(([params]) => params as SearchParams);

let navigateTo: NavigateFunction;
function LocationProbe() {
  const location = useLocation();
  navigateTo = useNavigate();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function LogoutButton() {
  const { logout, refreshUser } = useAuth();
  return (
    <>
      <button type="button" onClick={() => void logout()}>Test logout</button>
      <button type="button" onClick={() => void refreshUser()}>Test refresh user</button>
    </>
  );
}

function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/** SearchPage with a real history stack; `index` defaults to the last entry. */
function renderSearch(entries: string[], index = entries.length - 1) {
  return render(
    <Providers>
      <MemoryRouter initialEntries={entries} initialIndex={index}>
        <SearchPage />
        <LocationProbe />
        <LogoutButton />
      </MemoryRouter>
    </Providers>,
  );
}

/** A start page linking to a bare /search, like the Search tab. */
function renderFromLink(start = "/") {
  return render(
    <StrictMode>
      <Providers>
        <MemoryRouter initialEntries={[start]}>
          <Routes>
            <Route path="/" element={<Link to="/search">Go to search</Link>} />
            <Route path="/search" element={<SearchPage />} />
          </Routes>
          <LocationProbe />
          <LogoutButton />
        </MemoryRouter>
      </Providers>
    </StrictMode>,
  );
}

const location = () => screen.getByTestId("location").textContent;
const searchBox = () => screen.getByRole("textbox", { name: "Search terms" });

beforeEach(() => {
  search.mockReset();
  search.mockResolvedValue(result());
  vi.mocked(api.get).mockReset();
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === "/users/me") return { data: { id: "u1", email: "a@example.com", display_name: "Ada" } };
    return { data: [] };
  });
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockResolvedValue({ data: {} });
});

afterEach(() => {
  clearLastSearch();
});

describe("SearchPage — results", () => {
  it("has a page heading before and after a search", async () => {
    renderSearch(["/search"]);
    expect(screen.getByRole("heading", { level: 1, name: "Search the literature" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();

    fireEvent.change(searchBox(), { target: { value: "databases" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Solo Paper");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "Search results" })).toHaveClass("sr-only");
  });

  it("runs the search in the URL and says where the results come from", async () => {
    renderSearch(["/search?q=databases"]);
    expect(await screen.findByText("Solo Paper")).toBeInTheDocument();
    expect(screen.getByText("Grouped Paper")).toBeInTheDocument();
    expect(searchBox()).toHaveValue("databases");
    expect(screen.getByTestId("search-status")).toHaveTextContent("Semantic Scholar · 2 of about 1,234 results");
    expect(searchCalls()).toEqual([{ q: "databases", size: 20, page: 1 }]);
    // The anonymous startup (a failed cookie refresh) keeps it as the last search.
    expect(getLastSearch()).toBe("q=databases");
  });

  it("shows a humanized version picker for grouped results", async () => {
    renderSearch(["/search?q=databases"]);
    await screen.findByText("Grouped Paper");
    const picker = screen.getByTestId("version-picker");
    expect(picker).toHaveTextContent("Published 2025 · Crossref");
    expect(picker).toHaveTextContent("Preprint v1 · arXiv");
  });

  it("hides user-scoped pills and actions for anonymous visitors", async () => {
    renderSearch(["/search?q=databases"]);
    await screen.findByText("Solo Paper");
    expect(screen.queryByText("Not in a collection")).toBeNull();
    expect(screen.queryByText("Hide dismissed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Not relevant" })).toBeNull();
    // Cite and the citation graph need no account.
    expect(screen.getAllByRole("button", { name: "Cite" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Explore graph" })[0]).toHaveAttribute(
      "href",
      "/graph/doi%3A10.1%2Fsolo",
    );
  });

  it("says when Semantic Scholar has no matches", async () => {
    search.mockResolvedValue(result({ items: [], total_count: 0, total_estimate: 0 }));
    renderSearch(["/search?q=zzzz"]);
    expect(await screen.findByText("No matches in Semantic Scholar")).toBeInTheDocument();
    expect(screen.getByText("No papers found")).toBeInTheDocument();
  });

  it("explains an unavailable provider and retries", async () => {
    search.mockRejectedValueOnce(providerError(503, "provider_unavailable"));
    renderSearch(["/search?q=databases"]);
    expect(await screen.findByText(/Semantic Scholar is unavailable right now/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Solo Paper")).toBeInTheDocument();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("gives the operator message when the provider is not configured", async () => {
    search.mockRejectedValue(providerError(503, "provider_not_configured"));
    renderSearch(["/search?q=databases"]);
    expect(await screen.findByText(/set SEMANTIC_SCHOLAR_API_KEY/)).toBeInTheDocument();
    expect(screen.queryByText("server text")).toBeNull();
    // Trying again cannot fix the server's configuration.
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
  });

  it("holds Retry back while a rate limit lasts, searching again included", async () => {
    search.mockRejectedValue(providerError(503, "provider_rate_limited", { "retry-after": "30" }));
    renderSearch(["/search?q=databases"]);
    expect(
      await screen.findByText("Semantic Scholar is receiving too many requests. Please wait a moment and try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Try again in \d+ s$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("adds the partial notice at the provider's result window", async () => {
    search.mockResolvedValue(result({ window_capped: true, total_estimate: 25000 }));
    renderSearch(["/search?q=graph"]);
    expect(await screen.findByText(/Only the first 1,000 results are available/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});

describe("SearchPage — URL and history", () => {
  it("writes the search to the URL on submit, never while typing", async () => {
    renderSearch(["/search?q=first"]);
    await screen.findByText("Solo Paper");
    expect(search).toHaveBeenCalledTimes(1);

    for (const value of ["s", "se", "sec", "second"]) {
      fireEvent.change(searchBox(), { target: { value } });
    }
    expect(location()).toBe("/search?q=first");
    expect(search).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(location()).toBe("/search?q=second"));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(searchCalls()[1]).toMatchObject({ q: "second" });

    // One submit, one history entry: Back returns to the previous search.
    act(() => navigateTo(-1));
    expect(location()).toBe("/search?q=first");
    expect(searchBox()).toHaveValue("first");
    act(() => navigateTo(1));
    expect(location()).toBe("/search?q=second");
    expect(searchBox()).toHaveValue("second");
  });

  it("does not add an entry when the same search is submitted again", async () => {
    renderSearch(["/", "/search?q=databases"]);
    await screen.findByText("Solo Paper");
    fireEvent.change(searchBox(), { target: { value: "  databases " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(location()).toBe("/search?q=databases");
    act(() => navigateTo(-1));
    expect(location()).toBe("/");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("refetches the same search after a reload", async () => {
    const url = "/search?q=gnn&year_from=2019&oa=1&sort=citations";
    const first = renderSearch([url]);
    await screen.findByText("Solo Paper");
    first.unmount();
    renderSearch([url]);
    await screen.findByText("Solo Paper");
    const calls = searchCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ q: "gnn", size: 20, year_from: 2019, open_access_only: true, sort: "citations", page: 1 });
    expect(calls[1]).toEqual(calls[0]);
    expect(searchBox()).toHaveValue("gnn");
  });

  it("clears the text box without leaving the search", async () => {
    renderSearch(["/search?q=databases"]);
    await screen.findByText("Solo Paper");
    fireEvent.click(screen.getByRole("button", { name: "Clear search text" }));
    expect(searchBox()).toHaveValue("");
    expect(searchBox()).toHaveFocus();
    expect(location()).toBe("/search?q=databases");
    expect(screen.getByText("Solo Paper")).toBeInTheDocument();
  });
});

describe("SearchPage — sticky field", () => {
  let scrollY = 0;
  let originalScrollY: PropertyDescriptor | undefined;
  beforeEach(() => {
    scrollY = 0;
    // jsdom defines scrollY as an own data property: keep it to put it back afterwards.
    originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
    vi.spyOn(window, "scrollTo").mockImplementation(((_x: number, y: number) => {
      scrollY = y;
    }) as typeof window.scrollTo);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalScrollY) Object.defineProperty(window, "scrollY", originalScrollY);
    else Reflect.deleteProperty(window, "scrollY");
    clearScrollPositions();
  });

  it("starts a search at the top, and Back returns to its recorded position", async () => {
    // Arriving from a page scrolled down (the landing page, say).
    scrollY = 600;
    renderSearch(["/", "/search?q=first"]);
    expect(scrollY).toBe(0);
    await screen.findByText("Solo Paper");

    scrollY = 900;
    fireEvent.scroll(window);
    fireEvent.change(searchBox(), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(location()).toBe("/search?q=second"));
    expect(scrollY).toBe(0);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));

    act(() => navigateTo(-1));
    await waitFor(() => expect(scrollY).toBe(900));
    expect(location()).toBe("/search?q=first");
  });

  it("measures the sticky field for the root's scroll padding", () => {
    const heights: Record<string, number> = { "search-top": 127.4, "search-bar": 46 };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const height = heights[this.classList[0] ?? ""] ?? 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height } as DOMRect;
    });
    const root = document.documentElement.style;
    const view = renderSearch(["/search?q=gnn"]);
    expect(root.getPropertyValue("--search-top-height")).toBe("128px");
    expect(root.getPropertyValue("--search-bar-height")).toBe("46px");
    view.unmount();
    expect(root.getPropertyValue("--search-top-height")).toBe("");
    expect(root.getPropertyValue("--search-bar-height")).toBe("");
  });
});

const yearChip = () => screen.getByRole("button", { name: /^Year/ });
const sortChip = () => screen.getByRole("button", { name: /^Sort/ });

describe("SearchPage — filters", () => {
  it("keeps filters in the URL, names them in the status line and resets them", async () => {
    renderSearch(["/search?q=gnn"]);
    await screen.findByText("Solo Paper");

    fireEvent.click(sortChip());
    fireEvent.click(screen.getByRole("option", { name: "Newest first" }));
    await waitFor(() => expect(location()).toBe("/search?q=gnn&sort=date"));
    expect(screen.getByText(/lists only papers that match all of your words/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open access" }));
    await waitFor(() => expect(location()).toBe("/search?q=gnn&oa=1&sort=date"));
    expect(screen.getByRole("button", { name: "Open access" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(yearChip());
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2019" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2021" } });
    expect(location()).toBe("/search?q=gnn&oa=1&sort=date");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(location()).toBe("/search?q=gnn&year_from=2019&year_to=2021&oa=1&sort=date"));
    expect(yearChip()).toHaveAccessibleName("Year: 2019–2021");
    await waitFor(() =>
      expect(searchCalls().pop()).toEqual({
        q: "gnn", size: 20, year_from: 2019, year_to: 2021, open_access_only: true, sort: "date", page: 1,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("search-status")).toHaveTextContent(
        "Semantic Scholar · 2 of about 1,234 results · 2019–2021 · open access only · newest first",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(location()).toBe("/search?q=gnn&sort=date"));
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
    fireEvent.click(yearChip());
    expect(screen.getByLabelText("From")).toHaveValue(null);

    // Each applied change was one deliberate history entry.
    act(() => navigateTo(-1));
    expect(location()).toBe("/search?q=gnn&year_from=2019&year_to=2021&oa=1&sort=date");
    expect(screen.getByLabelText("From")).toHaveValue(2019);
  });

  it("rejects a reversed year range without searching", async () => {
    renderSearch(["/search?q=gnn"]);
    await screen.findByText("Solo Paper");
    fireEvent.click(yearChip());
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2022" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2020" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The start year can’t be later than the end year.");
    expect(screen.getByLabelText("From")).toHaveAttribute("aria-invalid", "true");
    expect(location()).toBe("/search?q=gnn");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("drops invalid values from a pasted URL", async () => {
    renderSearch(["/search?q=gnn&year_from=1500&sort=popular&oa=maybe"]);
    await screen.findByText("Solo Paper");
    expect(searchCalls()).toEqual([{ q: "gnn", size: 20, page: 1 }]);
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
    expect(yearChip()).toHaveAccessibleName("Year");
  });

  it("applies typed years with the next search, and stops on invalid ones", async () => {
    renderSearch(["/search?q=gnn"]);
    await screen.findByText("Solo Paper");
    fireEvent.click(yearChip());
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "1700" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a year between 1800");
    expect(location()).toBe("/search?q=gnn");

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2019" } });
    fireEvent.change(searchBox(), { target: { value: "graphs" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(location()).toBe("/search?q=graphs&year_from=2019"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(yearChip()).toHaveAccessibleName("Year: Since 2019");
    await waitFor(() => expect(searchCalls().pop()).toEqual({ q: "graphs", size: 20, year_from: 2019, page: 1 }));
  });

  it("applies a sort chosen from the listbox as one history entry", async () => {
    renderSearch(["/", "/search?q=gnn"]);
    await screen.findByText("Solo Paper");
    fireEvent.click(sortChip());
    const listbox = screen.getByRole("listbox", { name: "Sort by" });
    // Moving through the options searches nothing; Enter chooses.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(location()).toBe("/search?q=gnn");
    fireEvent.keyDown(listbox, { key: "Enter" });
    await waitFor(() => expect(location()).toBe("/search?q=gnn&sort=citations"));
    expect(sortChip()).toHaveFocus();
    expect(screen.getByText(/lists only papers that match all of your words/)).toBeInTheDocument();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(searchCalls().map((call) => call.sort)).toEqual([undefined, "citations"]);
    act(() => navigateTo(-1));
    expect(location()).toBe("/search?q=gnn");
  });
});

describe("SearchPage — Show more", () => {
  it("asks for the next page number for relevance and deduplicates", async () => {
    search.mockImplementation(async (params: SearchParams) =>
      params.page === 1
        ? result({ has_more: true })
        : result({
            page: 2,
            has_more: false,
            items: [baseItems[0]!, { kind: "paper", paper: paper("later", "Later paper") }],
          }),
    );
    renderSearch(["/search?q=databases"]);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Later paper")).toBeInTheDocument();
    expect(screen.getAllByText("Solo Paper")).toHaveLength(1);
    expect(searchCalls()[1]).toEqual({ q: "databases", size: 20, page: 2 });
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.getByTestId("search-status")).toHaveTextContent("3 of about 1,234 results");
  });

  it("follows the cursor for the citation sort", async () => {
    search.mockImplementation(async (params: SearchParams) =>
      params.cursor
        ? result({ sort: "citations", next_cursor: null, items: [{ kind: "paper", paper: paper("next", "Cursor paper") }] })
        : result({ sort: "citations", next_cursor: "c2", has_more: true }),
    );
    renderSearch(["/search?q=gnn&sort=citations"]);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Cursor paper")).toBeInTheDocument();
    expect(searchCalls()[1]).toEqual({ q: "gnn", size: 20, sort: "citations", cursor: "c2" });
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("keeps loaded results when the next page fails, then retries it", async () => {
    let fail = true;
    search.mockImplementation(async (params: SearchParams) => {
      if (params.page === 2 && fail) throw providerError(503, "provider_unavailable");
      return params.page === 1
        ? result({ has_more: true })
        : result({ page: 2, items: [{ kind: "paper", paper: paper("last", "Final paper") }] });
    });
    renderSearch(["/search?q=databases"]);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Semantic Scholar is unavailable right now.");
    expect(screen.getByText("Solo Paper")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Final paper")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(searchCalls().filter((call) => call.page === 1)).toHaveLength(1);
  });

  it("holds the next page's Retry back while a rate limit lasts", async () => {
    let failedAt = 0;
    search.mockImplementation(async (params: SearchParams) => {
      if (params.page === 1) return result({ has_more: true });
      failedAt = Date.now();
      throw providerError(503, "provider_rate_limited", { "retry-after": "30" });
    });
    renderSearch(["/search?q=databases"]);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("receiving too many requests. Please wait a moment and try again.");
    expect(screen.getByText("Solo Paper")).toBeInTheDocument();
    const retry = within(alert).getByRole("button", { name: "Try again" });
    expect(retry).toBeDisabled();

    // Once the wait is over, the countdown's next tick enables Retry.
    const clock = vi.spyOn(Date, "now").mockReturnValue(failedAt + 31_000);
    try {
      await waitFor(() => expect(retry).toBeEnabled(), { timeout: 2500 });
    } finally {
      clock.mockRestore();
    }
  });
});

describe("SearchPage — last search", () => {
  it("reopens the last search on a bare /search reached by a link, replacing it", async () => {
    setLastSearch("q=saved&sort=date");
    renderFromLink();
    fireEvent.click(screen.getByRole("link", { name: "Go to search" }));
    await waitFor(() => expect(location()).toBe("/search?q=saved&sort=date"));
    expect(searchBox()).toHaveValue("saved");
    await screen.findByText("Solo Paper");
    expect(searchCalls()).toEqual([{ q: "saved", size: 20, sort: "date", page: 1 }]);
    // The bare entry was replaced, so Back leaves Search.
    act(() => navigateTo(-1));
    expect(location()).toBe("/");
  });

  it("remembers the search on screen and stays blank without one", async () => {
    renderFromLink();
    fireEvent.click(screen.getByRole("link", { name: "Go to search" }));
    expect(location()).toBe("/search");
    expect(searchBox()).toHaveValue("");
    expect(search).not.toHaveBeenCalled();

    fireEvent.change(searchBox(), { target: { value: "graphs" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Solo Paper");
    expect(getLastSearch()).toBe("q=graphs");
  });

  it("does not reopen the last search when Back returns to a blank search", async () => {
    setLastSearch("q=old");
    renderSearch(["/search", "/search?q=newer"]);
    await screen.findByText("Solo Paper");
    act(() => navigateTo(-1));
    expect(location()).toBe("/search");
    expect(searchBox()).toHaveValue("");
    expect(getLastSearch()).toBeNull();
  });

  it("forgets the last search on logout", async () => {
    testAuth.authenticated = true;
    renderSearch(["/search?q=private+topic"]);
    await screen.findByText("Solo Paper");
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/users/me"));
    expect(getLastSearch()).toBe("q=private+topic");
    fireEvent.click(screen.getByRole("button", { name: "Test logout" }));
    await waitFor(() => expect(getLastSearch()).toBeNull());
    expect(api.post).toHaveBeenCalledWith("/auth/logout");
  });
});

it("forgets the last search when another user signs in", async () => {
  testAuth.authenticated = true;
  renderSearch(["/search?q=private+topic"]);
  await screen.findByText("Solo Paper");
  await waitFor(() => expect(api.get).toHaveBeenCalledWith("/users/me"));
  expect(getLastSearch()).toBe("q=private+topic");
  vi.mocked(api.get).mockImplementation(async (url: string) =>
    url === "/users/me" ? { data: { id: "u2", email: "b@example.com", display_name: "Bo" } } : { data: [] },
  );
  fireEvent.click(screen.getByRole("button", { name: "Test refresh user" }));
  await waitFor(() => expect(getLastSearch()).toBeNull());
});

describe("SearchPage — possible other versions", () => {
  it("shows the related result and moves focus to it", async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    const survey = paper("s2:aaa", "A Comprehensive Survey on Graph Neural Networks");
    const other = paper("s2:bbb", "A comprehensive survey on graph neural networks", { cited_by_count: 40 });
    search.mockResolvedValue(
      result({
        items: [
          {
            kind: "paper",
            paper: survey,
            possible_versions: [{ paper_group_key: other.paper_group_key, title: other.title, provider_sources: [] }],
          },
          { kind: "paper", paper: other },
        ],
      }),
    );
    renderSearch(["/search?q=gnn+survey"]);
    expect(await screen.findByText("Possible other version:")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Show “${other.title}”` }));
    const target = document.getElementById(resultElementId(other.paper_group_key));
    expect(target).toHaveFocus();
    expect(target).toHaveClass("search-result--highlight");
    expect(scrollIntoView).toHaveBeenCalled();
    await waitFor(() => expect(target).not.toHaveClass("search-result--highlight"), { timeout: 3000 });
    Element.prototype.scrollIntoView = original;
  });

  it("shows which provider the citation count comes from", async () => {
    renderSearch(["/search?q=databases"]);
    await screen.findByText("Solo Paper");
    const meta = screen.getAllByText((_, element) => element?.classList.contains("paper-meta") ?? false);
    // Rows leave the visible provider to the status line; assistive tech and
    // the tooltip still name it with the count.
    expect(meta[0]).toHaveTextContent("VLDB · 2024 · Cited by 5, Citation count from Semantic Scholar");
    expect(meta[0]!.querySelector(".paper-citations")).toHaveAttribute(
      "title",
      "Citation count from Semantic Scholar",
    );
    expect(screen.getByTestId("search-status")).toHaveTextContent(/^Semantic Scholar ·/);
  });
});

describe("SearchPage — version picker", () => {
  it("exposes versions as radios with unique names and a checked selection", async () => {
    const preprint = { paper_group_key: "group:p", provider_source: "crossref", paper_type: "posted-content" };
    const first = paper("doi:10.20944/p.v1", "Same Year", { ...preprint, publication_date: "2021-01-04" });
    const second = paper("doi:10.20944/p.v2", "Same Year", { ...preprint, publication_date: "2021-03-09" });
    search.mockResolvedValue(
      result({
        items: [
          {
            kind: "paper_group",
            paper_group_key: "group:p",
            title: "Same Year",
            authors: [],
            version_count: 2,
            selected_version: second,
            versions: [second, first],
            provider_sources: ["crossref"],
          },
        ],
      }),
    );
    renderWithProviders(<SearchPage />, { route: "/search?q=same" });
    await screen.findByText("Same Year");

    const group = screen.getByRole("radiogroup", { name: "Versions of this paper" });
    const radios = within(group).getAllByRole("radio");
    const names = radios.map((radio) => radio.getAttribute("aria-label") ?? "");
    expect(new Set(names).size).toBe(2);
    expect(names.join(" ")).not.toMatch(/10\.20944|doi:/);
    expect(radios[0]).toHaveTextContent("Preprint 2021 · Crossref · Posted Mar 9, 2021");
    expect(radios[0]).toHaveAttribute("aria-checked", "true");

    fireEvent.click(radios[1]!);
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[1]!, { key: "ArrowRight" });
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[0]).toHaveFocus();
  });
});

describe("SearchPage — Search link", () => {
  it.each([
    ["top navigation", TopNav],
    ["tab bar", MobileTabBar],
  ])("reopens the search on screen from the %s without a duplicate history entry", async (_, Nav) => {
    render(
      <Providers>
        <MemoryRouter initialEntries={["/", "/search?q=foo"]} initialIndex={1}>
          <Nav />
          <SearchPage />
          <LocationProbe />
        </MemoryRouter>
      </Providers>,
    );
    await screen.findByText("Solo Paper");
    fireEvent.click(screen.getByRole("link", { name: "Search" }));
    await waitFor(() => expect(location()).toBe("/search?q=foo"));
    expect(searchBox()).toHaveValue("foo");
    act(() => navigateTo(-1));
    expect(location()).toBe("/");
  });
});

describe("SearchPage — signed-in filters and row actions", () => {
  function signIn() {
    testAuth.authenticated = true;
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === "/users/me") return { data: { id: "u1", email: "a@example.com", display_name: "Ada" } };
      if (url === "/collections/paper-memberships") return { data: { "doi:10.1/solo": ["c1"] } };
      return { data: [] };
    });
  }

  it("filters the loaded results with the personal chips, named in the status line", async () => {
    signIn();
    renderSearch(["/search?q=databases"]);
    await screen.findByText("Solo Paper");
    const unsaved = await screen.findByRole("button", { name: "Not in a collection" });
    expect(screen.getByRole("button", { name: "Hide dismissed" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/collections/paper-memberships"));
    await screen.findByText(/^In \d+ collections?$/);

    fireEvent.click(unsaved);
    await waitFor(() => expect(screen.queryByText("Solo Paper")).toBeNull());
    expect(screen.getByTestId("search-status")).toHaveTextContent("1 of about 1,234 results · not in a collection");
    // A local filter: no new search and no history entry.
    expect(location()).toBe("/search?q=databases");
    expect(search).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(await screen.findByText("Solo Paper")).toBeInTheDocument();
    expect(unsaved).toHaveAttribute("aria-pressed", "false");
  });

  it("offers quiet Save, Cite and Not relevant actions on each row", async () => {
    signIn();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderSearch(["/search?q=databases"]);
    const title = await screen.findByRole("button", { name: "Solo Paper" });
    const row = title.closest("li")!;
    expect(within(row).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Not relevant" })).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Cite" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Smith, A. (2024). Solo Paper. VLDB."));
    expect(await screen.findByText("Reference copied to the clipboard")).toBeInTheDocument();
  });

  it("folds Cite, Explore graph and Not relevant into a More menu on phones", async () => {
    signIn();
    mockMatchMedia((query) => query === COMPACT_QUERY);
    try {
      renderSearch(["/search?q=databases"]);
      const title = await screen.findByRole("button", { name: "Solo Paper" });
      const row = title.closest("li")!;
      expect(within(row).queryByRole("button", { name: "Cite" })).toBeNull();
      const more = within(row).getByRole("button", { name: "More actions" });
      fireEvent.click(more);
      const menu = within(row).getByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "Cite" })).toBeInTheDocument();
      expect(within(menu).getByRole("menuitem", { name: "Explore graph" })).toHaveAttribute(
        "href",
        "/graph/doi%3A10.1%2Fsolo",
      );
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Not relevant" }));
      expect(within(row).queryByRole("menu")).toBeNull();
      expect(more).toHaveFocus();
      await waitFor(() => expect(api.post).toHaveBeenCalledWith("/papers/doi%3A10.1%2Fsolo/dismiss"));
    } finally {
      restoreMatchMedia();
    }
  });
});
