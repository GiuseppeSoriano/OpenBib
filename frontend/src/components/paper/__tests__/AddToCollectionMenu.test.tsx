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
  it("renders a labelled quiet trigger for list rows", () => {
    renderWithProviders(<AddToCollectionMenu canonicalKey="doi:10.1/add" variant="quiet" />);
    const trigger = screen.getByRole("button", { name: "Add to collection" });
    expect(trigger).toHaveClass("btn-quiet");
    expect(trigger).toHaveTextContent("Add to collection");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  });

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

  it("keeps each full collection name in the item's tooltip", async () => {
    renderWithProviders(
      <AddToCollectionMenu canonicalKey="doi:10.1/add" savedInCollections={["c2"]} />,
    );

    fireEvent.click(screen.getByTestId("add-to-collection"));
    const open = await screen.findByRole("menuitem", { name: /Deep Learning/ });
    expect(open).toHaveAttribute("title", "Deep Learning");
    const saved = screen.getByRole("menuitem", { name: /Optimization/ });
    expect(saved.getAttribute("title")).toMatch(/^Optimization\n\S/);
  });
});

describe("AddToCollectionMenu — outcomes", () => {
  async function addTo(name: RegExp) {
    renderWithProviders(<AddToCollectionMenu canonicalKey="doi:10.1/add" savedInCollections={[]} />);
    fireEvent.click(screen.getByTestId("add-to-collection"));
    fireEvent.click(await screen.findByRole("menuitem", { name }));
  }

  it("says when details are still pending", async () => {
    post.mockResolvedValueOnce({ data: { resolved: false } } as never);
    await addTo(/Deep Learning/);
    expect(await screen.findByText(/Added\. Details aren’t available yet/)).toBeInTheDocument();
  });

  it("marks a collection that already holds the paper", async () => {
    post.mockRejectedValueOnce({
      response: { status: 409, data: { detail: { code: "already_in_collection", message: "dup" } } },
    } as never);
    await addTo(/Deep Learning/);
    expect(await screen.findByText("This paper is already in the collection.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Deep Learning/ })).toBeDisabled());
  });

  it("explains a coded rejection", async () => {
    post.mockRejectedValueOnce({
      response: { status: 422, data: { detail: { code: "unknown_paper_key", message: "unknown" } } },
    } as never);
    await addTo(/Optimization/);
    expect(await screen.findByText("This paper reference isn’t known. Add it by DOI instead.")).toBeInTheDocument();
  });
});
