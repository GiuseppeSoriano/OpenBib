import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import CollectionsPage from "@/pages/CollectionsPage";
import { renderWithProviders } from "@/test/utils";
import api from "@/lib/api";
import { mockRefresh } from "@/test/auth-mock";

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
    const name = screen.getByPlaceholderText("Collection name");
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
