import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import CollectionsPage from "@/pages/CollectionsPage";
import { renderWithProviders } from "@/test/utils";
import api from "@/lib/api";
import { mockRefresh } from "@/test/auth-mock";
import { PHONE_QUERY } from "@/lib/breakpoints";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()), setAccessToken: vi.fn(), setAuthFailureHandler: vi.fn(),
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
beforeEach(() => vi.clearAllMocks());

describe("collection failures", () => {
  it("shows a minimal retry and recovers loading the list", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ data: [] });
    renderWithProviders(<CollectionsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load items");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No collections yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the creation form and input after failure", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    vi.mocked(api.post).mockRejectedValue(new Error("offline"));
    renderWithProviders(<CollectionsPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "New collection" })[0]!);
    const name = screen.getByLabelText("Collection name");
    fireEvent.change(name, { target: { value: "My work" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Could not create the collection. Please try again.")).toBeInTheDocument();
    expect(name).toHaveValue("My work");
  });

  it("reports deletion failure and preserves the collection", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [{ id: "one", name: "My work", is_owner: true, can_edit: true, paper_count: 0 }] });
    vi.mocked(api.delete).mockRejectedValue(new Error("offline"));
    renderWithProviders(<CollectionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete collection" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete collection" }));
    expect(await screen.findByText("Could not delete the collection. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /My work/ })).toBeInTheDocument();
  });
});

const COLLECTIONS = [
  { id: "one", name: "My work", description: "Thesis sources", is_owner: true, can_edit: true, paper_count: 12, updated_at: "2026-03-02T10:00:00Z" },
  { id: "two", name: "Lab shelf", description: null, is_owner: false, can_edit: false, paper_count: 3, updated_at: "2026-02-01T10:00:00Z" },
];

describe("collections list", () => {
  it("shows a table with papers, access and update date on wide screens", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: COLLECTIONS });
    renderWithProviders(<CollectionsPage />);
    const table = await screen.findByRole("table", { name: "Collections" });
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Name",
      "Papers",
      "Access",
      "Updated",
      "Actions",
    ]);
    const mine = within(table).getByRole("link", { name: "My work" }).closest("tr")!;
    expect(mine).toHaveTextContent("12");
    expect(mine).toHaveTextContent("Owner");
    expect(mine).toHaveTextContent("Thesis sources");
    expect(within(mine).getByRole("button", { name: "Delete collection" })).toHaveAccessibleDescription("My work");
    const shared = within(table).getByRole("link", { name: "Lab shelf" }).closest("tr")!;
    expect(shared).toHaveTextContent("Read only");
    // Only owners may delete.
    expect(within(shared).queryByRole("button", { name: "Delete collection" })).toBeNull();
  });

  it("lists hairline rows with a meta line on phones", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query === PHONE_QUERY,
    })) as typeof window.matchMedia;
    try {
      vi.mocked(api.get).mockResolvedValue({ data: COLLECTIONS });
      renderWithProviders(<CollectionsPage />);
      const list = await screen.findByRole("list", { name: "Collections" });
      expect(screen.queryByRole("table")).toBeNull();
      const rows = within(list).getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent(/12 papers · Owner/);
      expect(within(rows[0]!).getByRole("button", { name: "Delete collection" })).toBeInTheDocument();
      expect(rows[1]).toHaveTextContent(/3 papers · Read only/);
    } finally {
      window.matchMedia = original;
    }
  });
});
