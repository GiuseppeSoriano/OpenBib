import { testAuth, mockRefresh } from "@/test/auth-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import Layout from "@/components/Layout";
import { clearRecentSearches, rememberSearch, syncRecentSearchesOwner } from "@/lib/recentSearches";
import { renderWithProviders } from "@/test/utils";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn((url: string) => {
      if (url === "/users/me") return Promise.resolve({ data: { id: "u1", email: "ada@example.com", display_name: "Ada" } });
      if (url === "/collections")
        return Promise.resolve({ data: [{ id: "c1", name: "GNN survey", paper_count: 121, is_owner: true }] });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(),
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
  return (
    <>
      <output data-testid="where">{location.pathname + location.search}</output>
      {location.pathname === "/search" && (
        <form role="search">
          <input aria-label="Search papers" />
        </form>
      )}
    </>
  );
}

async function renderApp(route = "/", signedIn = true) {
  testAuth.authenticated = signedIn;
  renderWithProviders(
    <Routes>
      <Route element={<Layout />}>
        <Route path="*" element={<Where />} />
      </Route>
    </Routes>,
    { route },
  );
  if (signedIn) await screen.findByRole("complementary", { name: "Sidebar" });
  else await screen.findByRole("link", { name: /Sign in/ });
}

function palette() {
  return screen.getByRole("dialog", { name: "Search or jump to" });
}

describe("CommandPalette", () => {
  it("opens from the sidebar button as a dialog with a combobox and listbox", async () => {
    await renderApp();
    const opener = screen.getByTestId("palette-button");
    expect(opener).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K");
    opener.focus();
    fireEvent.click(opener);
    const input = within(palette()).getByRole("combobox", { name: "Search pages, collections and actions" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "true");
    const listbox = within(palette()).getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(within(listbox).getByRole("group", { name: "Pages" })).toBeInTheDocument();
    expect(await within(listbox).findByRole("option", { name: "GNN survey" })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("toggles with Ctrl+K and ⌘K", async () => {
    await renderApp();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(palette()).toBeInTheDocument();
    fireEvent.keyDown(within(palette()).getByRole("combobox"), { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document.body, { key: "K", metaKey: true });
    expect(palette()).toBeInTheDocument();
  });

  it("filters, moves with the arrow keys and runs the active option with Enter", async () => {
    await renderApp();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = within(palette()).getByRole("combobox");
    fireEvent.change(input, { target: { value: "lib" } });
    const options = within(palette()).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Search papers for “lib”", "Library"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
    expect(within(palette()).getByRole("status")).toHaveTextContent("2 results");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[1]!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/library"));
  });

  it("searches papers for the typed query", async () => {
    await renderApp();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = within(palette()).getByRole("combobox");
    fireEvent.change(input, { target: { value: "graph neural networks" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/search?q=graph+neural+networks"));
  });

  it("opens a collection, offers recent searches and toggles the theme", async () => {
    rememberSearch("q=message+passing");
    await renderApp();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(within(palette()).getByRole("group", { name: "Recent searches" })).toHaveTextContent("message passing");
    fireEvent.click(within(palette()).getByRole("option", { name: "Switch to the dark theme" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    fireEvent.change(within(palette()).getByRole("combobox"), { target: { value: "gnn" } });
    fireEvent.click(await within(palette()).findByRole("option", { name: "GNN survey" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/collections/c1"));
  });

  it("focuses the page's search field with /, or opens the palette where there is none", async () => {
    await renderApp("/search");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByRole("textbox", { name: "Search papers" })).toHaveFocus();
    // Typing "/" in a field is just text.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search papers" }), { key: "/" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: /^Library/ }));
    fireEvent.keyDown(document.body, { key: "/" });
    expect(palette()).toBeInTheDocument();
  });

  it("offers visitors public pages and sign-in only", async () => {
    await renderApp("/", false);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const pages = within(palette()).getByRole("group", { name: "Pages" });
    expect(within(pages).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Home",
      "Search",
      "Citation graph",
      "Sign in",
    ]);
    expect(within(palette()).queryByRole("option", { name: "New collection" })).toBeNull();
  });
});
