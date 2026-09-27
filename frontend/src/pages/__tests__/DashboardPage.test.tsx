import { mockRefresh } from "@/test/auth-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import api from "@/lib/api";
import DashboardPage from "@/pages/DashboardPage";
import { renderWithProviders } from "@/test/utils";
import type { Collection, UserStats } from "@/types";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: { get: vi.fn() },
}));

let backupsEnabled: boolean | undefined;
vi.mock("@/lib/legal", () => ({
  useLegalConfig: () => ({ data: { terms_version: "1", privacy_version: "1", backups_enabled: backupsEnabled } }),
}));

const NEW_USER: UserStats = { total_collections: 0, total_papers: 0, distinct_papers: 0, library_total: 0 };
const POPULATED: UserStats = { total_collections: 2, total_papers: 9, distinct_papers: 7, library_total: 11 };

const collection: Collection = {
  id: "c1",
  name: "Graph learning",
  description: null,
  visibility: "private",
  is_owner: true,
  can_edit: true,
  paper_count: 3,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function serve(stats: UserStats, collections: Collection[]) {
  vi.mocked(api.get).mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/users/me/stats" ? stats : collections }),
  );
}

async function show(language = "en") {
  await i18n.changeLanguage(language);
  return renderWithProviders(<DashboardPage />);
}

beforeEach(() => {
  backupsEnabled = true;
  vi.mocked(api.get).mockReset();
});

describe("DashboardPage", () => {
  it("guides a new user to search and collections instead of showing zero tiles", async () => {
    serve(NEW_USER, []);
    await show();
    expect(await screen.findByRole("heading", { level: 2, name: "Get started" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Find your first paper" })).toHaveAttribute("href", "/search");
    expect(screen.getByRole("link", { name: "New collection" })).toHaveAttribute("href", "/collections");
    expect(screen.queryByText("In Library")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("still lists collections shared with a new user", async () => {
    serve(NEW_USER, [{ ...collection, is_owner: false, can_edit: false }]);
    await show();
    expect(await screen.findByRole("heading", { level: 2, name: "Get started" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Graph learning/ })).toHaveAttribute("href", "/collections/c1");
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
    expect(container.querySelector(".stat-value")).toHaveTextContent("1");
    expect(within(empty).getByRole("link", { name: "Find papers" })).toHaveAttribute("href", "/search");
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
  });

  it("explains every tile, with the Library first", async () => {
    serve(POPULATED, [collection]);
    const { container } = await show();
    expect(await screen.findByText("11")).toBeInTheDocument();
    const tiles = Array.from(container.querySelectorAll(".stat-tile"));
    expect(tiles.map((tile) => tile.querySelector(".stat-label")?.textContent)).toEqual([
      "In Library",
      "Collections",
      "Total saves",
      "Unique papers",
    ]);
    expect(tiles.map((tile) => tile.querySelector(".stat-value")?.textContent)).toEqual(["11", "2", "9", "7"]);
    expect(tiles.map((tile) => tile.querySelector(".stat-hint")?.textContent)).toEqual([
      "Papers you’ve saved, each counted once",
      "Collections you own",
      "Papers added to your collections, repeats included",
      "Different papers across your collections",
    ]);
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Graph learning/ })).toHaveAttribute("href", "/collections/c1");
  });

  it("offers both next steps when the Library has papers but there are no collections", async () => {
    serve({ ...NEW_USER, library_total: 4 }, []);
    await show();
    const empty = await screen.findByTestId("empty-state");
    expect(within(empty).getByRole("link", { name: "Find papers" })).toHaveAttribute("href", "/search");
    expect(within(empty).getByRole("link", { name: "New collection" })).toHaveAttribute("href", "/collections");
    expect(screen.queryByRole("link", { name: "Find your first paper" })).not.toBeInTheDocument();
  });

  it.each([
    [false, 4, true],
    [false, 0, false],
    [true, 4, false],
    [undefined, 4, false],
  ])("shows the export reminder only without backups and with a Library (backups %s, %i papers)", async (enabled, library, visible) => {
    backupsEnabled = enabled;
    serve({ ...POPULATED, library_total: library }, [collection]);
    await show();
    await screen.findByText("Graph learning");
    const link = screen.queryByRole("link", { name: "Export your data" });
    if (visible) {
      expect(link).toHaveAttribute("href", "/settings#your-data");
      expect(screen.getByText(/doesn’t create backups/)).toBeInTheDocument();
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
    expect(container.querySelector(".stat-label")).toHaveTextContent("In Libreria");
    expect(screen.getByText("Articoli distinti nelle tue raccolte")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Esporta i tuoi dati" })).toHaveAttribute("href", "/settings#your-data");
    expect(screen.getByRole("link", { name: "Trova articoli" })).toHaveAttribute("href", "/search");
  });

  it("introduces a new user in Italian", async () => {
    serve(NEW_USER, []);
    await show("it");
    expect(await screen.findByRole("heading", { level: 2, name: "Per iniziare" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trova il tuo primo articolo" })).toHaveAttribute("href", "/search");
    expect(screen.getByRole("link", { name: "Nuova raccolta" })).toHaveAttribute("href", "/collections");
  });
});
