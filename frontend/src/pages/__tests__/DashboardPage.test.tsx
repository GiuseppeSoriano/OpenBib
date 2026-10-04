import { mockRefresh } from "@/test/auth-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import api, { library } from "@/lib/api";
import DashboardPage from "@/pages/DashboardPage";
import { PHONE_QUERY } from "@/lib/breakpoints";
import { mockMatchMedia, renderWithProviders, restoreMatchMedia } from "@/test/utils";
import type {
  Collection,
  LibraryEntryListItem,
  LibraryFacets,
  LibraryListParams,
  PaperMetadata,
  UserStats,
} from "@/types";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: { get: vi.fn() },
  library: { listEntries: vi.fn(), getFacets: vi.fn() },
}));

let backupsEnabled: boolean | undefined;
vi.mock("@/lib/legal", () => ({
  useLegalConfig: () => ({ data: { terms_version: "1", privacy_version: "1", backups_enabled: backupsEnabled } }),
}));

const NEW_USER: UserStats = { total_collections: 0, total_papers: 0, distinct_papers: 0, library_total: 0 };
const POPULATED: UserStats = { total_collections: 2, total_papers: 9, distinct_papers: 7, library_total: 11 };
const NO_FACETS: LibraryFacets = { tags: [], states: [], total: 0, unresolved: 0 };

const collection: Collection = {
  id: "c1",
  name: "Graph learning",
  description: null,
  revision: 1,
  can_manage_access: true,
  is_owner: true,
  can_edit: true,
  paper_count: 3,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function entry(key: string, title: string, paper: Partial<PaperMetadata> = {}): LibraryEntryListItem {
  return {
    paper_group_key: key,
    primary_canonical_key: `doi:${key}`,
    created_at: "2026-10-03T18:00:00Z",
    resolved: true,
    version_count: 1,
    tags: [],
    primary_version: {
      canonical_key: `doi:${key}`,
      paper_group_key: key,
      title,
      authors: [],
      abstract: null,
      publication_date: null,
      doi: null,
      arxiv_id: null,
      venue: null,
      paper_type: null,
      topics: [],
      keywords: [],
      open_access: null,
      pdf_url: null,
      cited_by_count: null,
      reference_count: null,
      provider_source: "semantic_scholar",
      provider_sources: [],
      ...paper,
    },
  };
}

function page(items: LibraryEntryListItem[]) {
  return { items, total: items.length, page: 1, size: 5 };
}

function serve(stats: UserStats, collections: Collection[]) {
  vi.mocked(api.get).mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/users/me/stats" ? stats : collections }),
  );
}

/** Library answers by state: `{ reading: [...], to_read: [...], recent: [...] }`. */
function serveLibrary(
  lists: { reading?: LibraryEntryListItem[]; to_read?: LibraryEntryListItem[]; recent?: LibraryEntryListItem[] },
  facets: LibraryFacets = NO_FACETS,
) {
  vi.mocked(library.getFacets).mockResolvedValue(facets);
  vi.mocked(library.listEntries).mockImplementation((params: LibraryListParams = {}) => {
    const key = params.state === "reading" ? "reading" : params.state === "to_read" ? "to_read" : "recent";
    return Promise.resolve(page(lists[key] ?? []));
  });
}

async function show(language = "en") {
  await i18n.changeLanguage(language);
  return renderWithProviders(<DashboardPage />);
}

function figureTexts(container: HTMLElement, selector: string) {
  return Array.from(container.querySelectorAll(`.dashboard-figure ${selector}`)).map((node) => node.textContent);
}

beforeEach(() => {
  vi.clearAllMocks();
  backupsEnabled = true;
  vi.mocked(api.get).mockReset();
  serveLibrary({});
});

afterEach(() => {
  vi.useRealTimers();
  restoreMatchMedia();
});

describe("DashboardPage", () => {
  it("guides a new user to search and collections instead of showing zero figures", async () => {
    serve(NEW_USER, []);
    await show();
    expect(await screen.findByRole("heading", { level: 2, name: "Get started" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Find your first paper" })).toHaveAttribute("href", "/search");
    expect(screen.getByRole("link", { name: "New collection" })).toHaveAttribute("href", "/collections");
    expect(screen.queryByText("In Library")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(library.listEntries).not.toHaveBeenCalled();
    expect(library.getFacets).not.toHaveBeenCalled();
  });

  it("still lists collections shared with a new user", async () => {
    serve(NEW_USER, [{ ...collection, is_owner: false, can_edit: false }]);
    await show();
    expect(await screen.findByRole("heading", { level: 2, name: "Get started" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Graph learning" })).toHaveAttribute("href", "/collections/c1");
    expect(screen.getByRole("row", { name: /Graph learning/ })).toHaveTextContent("Read only");
    expect(screen.getAllByRole("link", { name: "Find your first paper" })).toHaveLength(1);
  });

  it("does not flash the onboarding or first steps while stats are loading", async () => {
    vi.mocked(api.get).mockImplementation((url: string) =>
      url === "/users/me/stats" ? new Promise(() => {}) : Promise.resolve({ data: [] }),
    );
    await show();
    expect(screen.getByText("In Library")).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/collections"));
    await act(async () => {});
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Find/ })).not.toBeInTheDocument();
  });

  it("refetches the stats on return so the onboarding does not outlive the first save", async () => {
    const user = userEvent.setup();
    // Same cache policy as the app, where queries stay fresh for five minutes.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } } });
    serve(NEW_USER, []);
    await i18n.changeLanguage("en");
    const { container } = renderWithProviders(
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/search" element={<Link to="/">Back to dashboard</Link>} />
        </Routes>
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("link", { name: "Find your first paper" }));

    let resolveStats: (value: { data: UserStats }) => void = () => {};
    vi.mocked(api.get).mockImplementation((url: string) =>
      url === "/users/me/stats"
        ? new Promise((resolve) => {
            resolveStats = resolve;
          })
        : Promise.resolve({ data: [] }),
    );
    await user.click(await screen.findByRole("link", { name: "Back to dashboard" }));
    expect(screen.getByText("In Library")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();

    await act(async () => resolveStats({ data: { ...NEW_USER, library_total: 1 } }));
    const empty = await screen.findByTestId("empty-state");
    expect(container.querySelector(".dashboard-figure-value")).toHaveTextContent("1");
    expect(within(empty).getByRole("link", { name: "Find papers" })).toHaveAttribute("href", "/search");
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
  });

  it("shows the Library, collections and reading figures, with the Library first", async () => {
    serve(POPULATED, [collection]);
    serveLibrary({}, { ...NO_FACETS, total: 11, states: [{ state: "to_read", count: 4 }, { state: "reading", count: 3 }] });
    const { container } = await show();
    await waitFor(() => expect(figureTexts(container, "dd")).toEqual(["11", "2", "3", "4"]));
    expect(figureTexts(container, "dt")).toEqual(["In Library", "Collections", "Reading", "To read"]);
    // S06: the figures explain what the Library and Collections count.
    expect(
      screen.getByText("In Library counts each saved paper once; Collections include those shared with you."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Graph learning" })).toHaveAttribute("href", "/collections/c1");
    // Outside the app shell the top bar's page action renders in place.
    expect(screen.getByRole("link", { name: "Find papers" })).toHaveAttribute("href", "/search");
  });

  it("leaves Find papers out of the phone top bar, which already has search", async () => {
    mockMatchMedia((query) => query === PHONE_QUERY);
    serve(POPULATED, [collection]);
    await show();
    expect(await screen.findByRole("link", { name: "Graph learning" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Find papers" })).not.toBeInTheDocument();
  });

  it("offers a retry instead of empty sections when the Library queries fail", async () => {
    serve(POPULATED, [collection]);
    vi.mocked(library.listEntries).mockRejectedValue(new Error("offline"));
    vi.mocked(library.getFacets).mockRejectedValue(new Error("offline"));
    const { container } = await show();
    const continueReading = await screen.findByRole("region", { name: "Continue reading" });
    expect(await within(continueReading).findByRole("alert")).toBeInTheDocument();
    expect(within(continueReading).queryByText(/Nothing in progress/)).not.toBeInTheDocument();
    const progress = screen.getByRole("region", { name: "Reading progress" });
    expect(await within(progress).findByRole("alert")).toBeInTheDocument();
    expect(within(progress).queryByRole("img")).not.toBeInTheDocument();
    const recent = screen.getByRole("region", { name: "Recently saved" });
    expect(await within(recent).findByRole("alert")).toBeInTheDocument();
    expect(within(recent).queryByRole("list")).not.toBeInTheDocument();
    expect(figureTexts(container, "dd")).toEqual(["11", "2", "–", "–"]);

    serveLibrary({ reading: [entry("g1", "The Graph Neural Network Model")] });
    const user = userEvent.setup();
    await user.click(within(continueReading).getByRole("button", { name: "Try again" }));
    expect(await within(continueReading).findByRole("link", { name: "The Graph Neural Network Model" })).toBeInTheDocument();
  });

  it("offers both next steps when the Library has papers but there are no collections", async () => {
    serve({ ...NEW_USER, library_total: 4 }, []);
    await show();
    const empty = await screen.findByTestId("empty-state");
    expect(within(empty).getByRole("link", { name: "Find papers" })).toHaveAttribute("href", "/search");
    expect(within(empty).getByRole("link", { name: "New collection" })).toHaveAttribute("href", "/collections");
    expect(screen.queryByRole("link", { name: "Find your first paper" })).not.toBeInTheDocument();
  });

  it("greets by the time of day under a date line", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 3, 20, 30));
    serve(POPULATED, []);
    const { unmount } = await show();
    expect(screen.getByRole("heading", { level: 1, name: "Good evening" })).toBeInTheDocument();
    expect(screen.getByText("Saturday, October 3")).toBeInTheDocument();
    unmount();
    vi.setSystemTime(new Date(2026, 9, 4, 9, 0));
    await show("it");
    expect(screen.getByRole("heading", { level: 1, name: "Buongiorno" })).toBeInTheDocument();
  });

  it("lists papers being read, then the reading list, numbered and linked to the Library", async () => {
    serve(POPULATED, [collection]);
    const shared = entry("g2", "Attention Is All You Need", {
      authors: ["Vaswani", "Shazeer", "Parmar", "Uszkoreit", "Jones"].map((family) => ({
        name: `A. ${family}`,
        family_name: family,
        openalex_id: null,
        orcid: null,
        affiliations: [],
      })),
      venue: "NeurIPS",
      publication_date: "2017-06-12",
    });
    serveLibrary({
      reading: [entry("g1", "The Graph Neural Network Model"), shared],
      to_read: [shared, entry("g3", "Graph Attention Networks")],
    });
    await show();
    const section = await screen.findByRole("region", { name: "Continue reading" });
    await waitFor(() => expect(within(section).getAllByRole("listitem")).toHaveLength(3));
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("link").textContent)).toEqual([
      "The Graph Neural Network Model",
      "Attention Is All You Need",
      "Graph Attention Networks",
    ]);
    expect(rows.map((row) => row.querySelector(".state-pill")?.textContent)).toEqual(["Reading", "Reading", "To read"]);
    expect(rows[2]!.querySelector(".state-pill")).toHaveClass("state-pill--toread");
    expect(within(rows[1]!).getByText("Vaswani, Shazeer, Parmar et al. · NeurIPS · 2017")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("link")).toHaveAttribute("href", "/library?focus=g1");
    expect(within(section).getByRole("link", { name: "All in progress" })).toHaveAttribute(
      "href",
      "/library?state=reading",
    );
    expect(library.listEntries).toHaveBeenCalledWith({ state: "reading", size: 5 });
    expect(library.listEntries).toHaveBeenCalledWith({ state: "to_read", size: 5 });
  });

  it("says so when nothing is in progress", async () => {
    serve(POPULATED, [collection]);
    await show();
    const section = await screen.findByRole("region", { name: "Continue reading" });
    expect(await within(section).findByText(/Nothing in progress/)).toBeInTheDocument();
    expect(within(section).queryByRole("list")).not.toBeInTheDocument();
  });

  it("draws reading progress from the Library facets, with a text alternative and legend", async () => {
    serve(POPULATED, [collection]);
    serveLibrary(
      {},
      {
        ...NO_FACETS,
        total: 11,
        states: [
          { state: "to_read", count: 4 },
          { state: "reading", count: 3 },
          { state: "read", count: 2 },
          { state: "important", count: 5 },
        ],
      },
    );
    const { container } = await show();
    const bar = await screen.findByRole("img", {
      name: "Library by reading state: 4 to read, 3 reading, 2 read, 2 other",
    });
    expect(bar.querySelectorAll("rect")).toHaveLength(4);
    const legend = Array.from(container.querySelectorAll(".dashboard-legend li")).map((item) => item.textContent);
    expect(legend).toEqual(["To read4", "Reading3", "Read2", "Other2"]);
  });

  it("lists recent saves newest first with relative times", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T20:00:00Z"));
    serve(POPULATED, [{ ...collection, updated_at: "2026-10-02T12:00:00Z", is_owner: false }]);
    serveLibrary({
      recent: [
        { ...entry("g4", "How Powerful are Graph Neural Networks?"), created_at: "2026-10-03T18:00:00Z" },
        { ...entry("g5", "Graph Attention Networks"), created_at: "2026-09-26T20:00:00Z" },
      ],
    });
    await show();
    const section = await screen.findByRole("region", { name: "Recently saved" });
    expect(await within(section).findByText("2 hours ago")).toBeInTheDocument();
    expect(within(section).getByText("last week")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "Graph Attention Networks" })).toHaveAttribute(
      "href",
      "/library?focus=g5",
    );
    expect(library.listEntries).toHaveBeenCalledWith({ sort: "added", size: 5 });

    const row = await screen.findByRole("row", { name: /Graph learning/ });
    expect(within(row).getByText("Can edit")).toBeInTheDocument();
    expect(within(row).getByText("yesterday")).toBeInTheDocument();
    expect(within(row).getByText("3")).toBeInTheDocument();
  });

  it.each([
    [false, 4, true],
    [false, 0, false],
    [true, 4, false],
    [undefined, 4, false],
  ])("shows the export reminder only without backups and with a Library (backups %s, %i papers)", async (enabled, papers, visible) => {
    backupsEnabled = enabled;
    serve({ ...POPULATED, library_total: papers }, [collection]);
    await show();
    await screen.findByText("Graph learning");
    const link = screen.queryByRole("link", { name: "Export your data" });
    if (visible) {
      expect(link).toHaveAttribute("href", "/settings#your-data");
      expect(screen.getByText(/doesn’t create backups/)).toHaveClass("margin-note");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    } else {
      expect(link).not.toBeInTheDocument();
    }
  });

  it("renders in Italian", async () => {
    backupsEnabled = false;
    serve(POPULATED, []);
    const { container } = await show("it");
    expect(await screen.findByText("11")).toBeInTheDocument();
    expect(figureTexts(container, "dt")).toEqual(["In Libreria", "Raccolte", "In lettura", "Da leggere"]);
    expect(
      screen.getByText("In Libreria conta ogni articolo salvato una volta; Raccolte include quelle condivise con te."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Continua a leggere" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Esporta i tuoi dati" })).toHaveAttribute("href", "/settings#your-data");
    const empty = await screen.findByTestId("empty-state");
    expect(within(empty).getByRole("link", { name: "Trova articoli" })).toHaveAttribute("href", "/search");
  });

  it("introduces a new user in Italian", async () => {
    serve(NEW_USER, []);
    await show("it");
    expect(await screen.findByRole("heading", { level: 2, name: "Per iniziare" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trova il tuo primo articolo" })).toHaveAttribute("href", "/search");
    expect(screen.getByRole("link", { name: "Nuova raccolta" })).toHaveAttribute("href", "/collections");
  });
});
