import { testAuth, mockRefresh } from "@/test/auth-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import api from "@/lib/api";
import Layout from "@/components/Layout";
import { clearRecentSearches, rememberSearch, syncRecentSearchesOwner } from "@/lib/recentSearches";
import { renderWithProviders } from "@/test/utils";

const many = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: `Collection ${i}`, paper_count: i, is_owner: i !== 1 }));

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn((url: string) => {
      if (url === "/users/me") return Promise.resolve({ data: { id: "u1", email: "ada@example.com", display_name: "Ada" } });
      if (url === "/collections") return Promise.resolve({ data: many });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(() => Promise.resolve({ data: { id: "new1", name: "Reading group" } })),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  papers: {},
  library: { listKeys: vi.fn(() => Promise.resolve([])) },
  notes: {},
  graph: {},
  zotero: {},
}));

afterEach(() => {
  clearRecentSearches();
  syncRecentSearchesOwner(null);
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderSidebar(route = "/") {
  testAuth.authenticated = true;
  return renderWithProviders(
    <Routes>
      <Route element={<Layout />}>
        <Route path="*" element={<Where />} />
      </Route>
    </Routes>,
    { route },
  );
}

describe("Sidebar", () => {
  it("lists the first eight collections, marks shared ones and links to all of them", async () => {
    const { container } = renderSidebar();
    const nav = await screen.findByRole("navigation", { name: "Your collections" });
    await within(nav).findByText("Collection 0");
    expect(within(nav).getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/collections/"))).toHaveLength(8);
    expect(within(nav).getByRole("link", { name: "All collections" })).toHaveAttribute("href", "/collections");
    expect(container.querySelectorAll(".sidebar-dot--shared")).toHaveLength(1);
  });

  it("marks one current page: an open listed collection, else Collections", async () => {
    const { container, unmount } = renderSidebar("/collections/c3");
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    await within(sidebar).findByText("Collection 3");
    const current = sidebar.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("href", "/collections/c3");
    expect(container.querySelectorAll(".sidebar-link--active")).toHaveLength(1);
    unmount();

    // Past the first eight, only Collections can show where you are.
    renderSidebar("/collections/c9");
    const again = await screen.findByRole("complementary", { name: "Sidebar" });
    await within(again).findByText("Collection 0");
    const primary = within(again).getByRole("navigation", { name: "Primary" });
    expect(within(primary).getByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
    expect(again.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("shows recent searches only on the Search page", async () => {
    rememberSearch("q=graph+neural+networks&sort=date");
    const { unmount } = renderSidebar("/search");
    const recent = await screen.findByRole("navigation", { name: "Recent searches" });
    expect(within(recent).getByRole("link", { name: "graph neural networks" })).toHaveAttribute(
      "href",
      "/search?q=graph+neural+networks&sort=date",
    );
    unmount();
    renderSidebar("/library");
    await screen.findByRole("navigation", { name: "Your collections" });
    expect(screen.queryByRole("navigation", { name: "Recent searches" })).toBeNull();
  });

  it("creates a collection from + and opens it", async () => {
    renderSidebar();
    const nav = await screen.findByRole("navigation", { name: "Your collections" });
    const plus = within(nav).getByRole("button", { name: "New collection" });
    plus.focus();
    fireEvent.click(plus);
    const dialog = await screen.findByRole("dialog", { name: "New collection" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Collection name" }), { target: { value: " Reading group " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/collections/new1"));
    expect(api.post).toHaveBeenCalledWith("/collections", { name: "Reading group", description: null });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the account menu upwards from the foot of the sidebar", async () => {
    renderSidebar();
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    const account = await within(sidebar).findByTestId("user-menu");
    expect(account).toHaveTextContent("Ada");
    expect(account).toHaveTextContent("ada@example.com");
    expect(within(sidebar).getByRole("button", { name: "Sign out" })).toHaveTextContent("Sign out");
    fireEvent.click(account);
    expect(screen.getByRole("menu")).toHaveClass("menu-popover--up");
  });
});
