import { mockRefresh } from "@/test/auth-mock";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import AddToCollectionMenu from "@/components/paper/AddToCollectionMenu";
import { renderWithProviders } from "@/test/utils";

const collections = [
  { id: "read-only", name: "Read only collection", can_edit: false, owner_id: "u2", paper_count: 0, created_at: "2026-01-01" },
  { id: "c1", name: "Deep Learning", can_edit: true, owner_id: "u1", paper_count: 3, created_at: "2026-01-01" },
  { id: "c2", name: "Optimization", can_edit: true, owner_id: "u1", paper_count: 1, created_at: "2026-01-02" },
];

const post = vi.fn(() => Promise.resolve({ data: {} }));

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn((url: string) => {
      if (url === "/collections") return Promise.resolve({ data: collections });
      return Promise.resolve({ data: [] });
    }),
    post: (...args: unknown[]) => post(...(args as [])),
    put: vi.fn(),
    delete: vi.fn(),
  },
  papers: {},
  library: {},
  notes: {},
  graph: {},
  zotero: {},
}));

beforeEach(() => post.mockClear());

describe("AddToCollectionMenu", () => {
  it("lists collections lazily when opened and adds the paper", async () => {
    renderWithProviders(
      <AddToCollectionMenu canonicalKey="doi:10.1/add" savedInCollections={[]} />,
    );

    fireEvent.click(screen.getByTestId("add-to-collection"));
    const item = await screen.findByRole("menuitem", { name: /Deep Learning/ });
    fireEvent.click(item);

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/collections/c1/papers", {
        paper_canonical_key: "doi:10.1/add",
      }),
    );
  });

  it("disables collections the paper is already saved in", async () => {
    renderWithProviders(
      <AddToCollectionMenu canonicalKey="doi:10.1/add" savedInCollections={["c2"]} />,
    );

    fireEvent.click(screen.getByTestId("add-to-collection"));
    const saved = await screen.findByRole("menuitem", { name: /Optimization/ });
    expect(screen.queryByRole("menuitem", { name: "Read only collection" })).toBeNull();
    expect(saved).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Deep Learning/ })).toBeEnabled();
  });
});
