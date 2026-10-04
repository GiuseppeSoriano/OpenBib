import { testAuth, mockRefresh } from "@/test/auth-mock";
import { afterEach, describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import Layout from "@/components/Layout";
import { TopBarActions, useShellChrome, useTopBarTitle } from "@/components/shell/ShellContext";
import { PHONE_QUERY, RAIL_QUERY } from "@/lib/breakpoints";
import { mockMatchMedia, renderWithProviders, restoreMatchMedia } from "@/test/utils";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn((url: string) => {
      if (url === "/users/me")
        return Promise.resolve({ data: { id: "u1", email: "ada@example.com", display_name: "Ada", created_at: "2026-01-01" } });
      if (url === "/collections")
        return Promise.resolve({
          data: [
            { id: "c1", name: "Thesis — chapter 2", paper_count: 48, is_owner: true },
            { id: "c2", name: "Lab reading", paper_count: 17, is_owner: false },
          ],
        });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  papers: {},
  library: { listKeys: vi.fn(() => Promise.resolve(["a", "b", "c"])) },
  notes: {},
  graph: {},
  zotero: {},
}));

afterEach(() => restoreMatchMedia());

/** Phone, tablet (rail) or desktop, as the shell's media queries see it. */
type Viewport = "phone" | "tablet" | "desktop";

function matcher(kind: Viewport) {
  return (query: string) => {
    if (query === PHONE_QUERY) return kind === "phone";
    if (query === RAIL_QUERY) return kind !== "desktop";
    return false;
  };
}

function viewport(kind: Viewport) {
  return mockMatchMedia(matcher(kind));
}

function renderShell(route = "/", page = <p>Page</p>) {
  return renderWithProviders(
    <Routes>
      <Route element={<Layout />}>
        <Route path="*" element={page} />
      </Route>
    </Routes>,
    { route },
  );
}

describe("Layout for visitors", () => {
  it("shows a minimal top bar: logo, Search, theme, language and Sign in, with no sidebar or tab bar", async () => {
    const { container } = renderShell();
    expect(await screen.findByRole("link", { name: /Sign in/ })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Search" })).toHaveAttribute("href", "/search");
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("language-menu")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "OpenBib" })).toHaveAttribute("href", "/");
    expect(screen.queryByTestId("user-menu")).toBeNull();
    expect(container.querySelector(".sidebar")).toBeNull();
    expect(container.querySelector(".tabbar")).toBeNull();
  });

  it("orders the top bar, main and footer links", async () => {
    const { container } = renderShell();
    await screen.findByText("Sign in");
    const shell = container.querySelector(".app-shell")!;
    expect(shell).toHaveClass("app-shell--anon");
    expect(Array.from(shell.children).map((el) => el.tagName)).toEqual(["HEADER", "MAIN", "FOOTER"]);
    const footer = shell.querySelector("footer")!;
    expect(within(footer).getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(within(footer).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  });

  it("links to the open-source repository from the footer", () => {
    renderShell();
    expect(screen.getByRole("link", { name: /Contribute on GitHub/ })).toHaveAttribute("href", "https://github.com/GiuseppeSoriano/OpenBib");
  });
});

describe("Layout for signed-in users on desktop", () => {
  it("puts navigation, collections, Settings and the account in the sidebar", async () => {
    testAuth.authenticated = true;
    const { container } = renderShell("/library");
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    const primary = within(sidebar).getByRole("navigation", { name: "Primary" });
    const links = within(primary).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/", "/search", "/library", "/collections", "/graph/library"]);
    expect(within(primary).getByRole("link", { name: /Library/ })).toHaveAttribute("aria-current", "page");
    expect(await within(primary).findByRole("link", { name: "Library (3 papers)" })).toBeInTheDocument();

    const collections = within(sidebar).getByRole("navigation", { name: "Your collections" });
    expect(await within(collections).findByRole("link", { name: "Thesis — chapter 2 (48 papers)" })).toHaveAttribute("href", "/collections/c1");
    expect(within(collections).getByRole("button", { name: "New collection" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(within(sidebar).getByTestId("user-menu")).toHaveAccessibleName("Ada");

    expect(container.querySelector(".tabbar")).toBeNull();
    expect(container.querySelector(".app-shell")).toHaveClass("app-shell--sidebar");
  });

  it("names the page in the top bar breadcrumb, or the title the page gives", async () => {
    testAuth.authenticated = true;
    function Detail() {
      useTopBarTitle("Thesis — chapter 2");
      return <p>Detail</p>;
    }
    renderShell("/collections/c1", <Detail />);
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Collections" })).toHaveAttribute("href", "/collections");
    expect(within(crumbs).getByText("Thesis — chapter 2")).toHaveAttribute("aria-current", "page");
  });

  it("shows page actions in the top bar", async () => {
    testAuth.authenticated = true;
    renderShell("/", <TopBarActions><button type="button">Import DOIs</button></TopBarActions>);
    const header = (await screen.findByRole("navigation", { name: "Breadcrumb" })).closest("header")!;
    expect(await within(header).findByRole("button", { name: "Import DOIs" })).toBeInTheDocument();
  });
});

describe("Layout sidebar rail", () => {
  it("collapses to an icon rail on desktop and remembers the choice", async () => {
    testAuth.authenticated = true;
    const { container } = renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Collapse sidebar" }));
    expect(container.querySelector(".sidebar")).toHaveClass("sidebar--rail");
    expect(container.querySelector(".app-shell")).toHaveClass("app-shell--rail");
    expect(localStorage.getItem("openbib.sidebar")).toBe("rail");
    // Icons keep their names; the collections list waits for the full sidebar.
    expect(screen.getByRole("link", { name: "Citation graph" })).toHaveAttribute("title", "Citation graph");
    expect(screen.queryByRole("navigation", { name: "Your collections" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(container.querySelector(".sidebar")).not.toHaveClass("sidebar--rail");
    expect(localStorage.getItem("openbib.sidebar")).toBe("full");
  });

  it("is always a rail on tablets, with nothing to expand", async () => {
    testAuth.authenticated = true;
    viewport("tablet");
    const { container } = renderShell();
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(container.querySelector(".sidebar")).toHaveClass("sidebar--rail");
    expect(screen.queryByRole("button", { name: /Collapse sidebar|Expand sidebar/ })).toBeNull();
    expect(screen.getByTestId("palette-button")).toHaveAccessibleName("Search or jump to…");
  });
});

describe("Layout for signed-in users on phones", () => {
  it("shows a top app bar and the bottom tab bar, cleared after the footer (F03)", async () => {
    testAuth.authenticated = true;
    viewport("phone");
    const { container } = renderShell("/search");
    const tabs = await screen.findByRole("navigation", { name: "Primary" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Home", "Search", "Library", "Collections"]);
    expect(within(tabs).getByRole("link", { name: "Search" })).toHaveAttribute("aria-current", "page");

    const shell = container.querySelector(".app-shell")!;
    expect(Array.from(shell.children).map((el) => el.tagName)).toEqual(["HEADER", "MAIN", "FOOTER", "NAV"]);
    expect(shell.lastElementChild).toHaveClass("tabbar");
    expect(container.querySelector(".sidebar")).toBeNull();

    const header = shell.querySelector("header")!;
    expect(within(header).getByRole("link", { name: "OpenBib" })).toHaveAttribute("href", "/");
    expect(within(header).getByRole("button", { name: "Search or jump to…" })).toBeInTheDocument();
    expect(await within(header).findByTestId("user-menu")).toBeInTheDocument();
  });

  it("labels the primary navigation in the current language", async () => {
    testAuth.authenticated = true;
    viewport("phone");
    renderShell();
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    await act(async () => {
      await i18n.changeLanguage("it");
    });
    expect(screen.getByRole("navigation", { name: "Principale" })).toBeInTheDocument();
  });
});

describe("Full-screen pages (citation graph)", () => {
  function renderBare() {
    return renderWithProviders(
      <Routes>
        <Route element={<Layout bare />}>
          <Route path="*" element={<TopBarActions><button type="button">Fit</button></TopBarActions>} />
        </Route>
      </Routes>,
      { route: "/graph/library" },
    );
  }

  it("renders without the sidebar, top bar or footer, and keeps page actions in place", async () => {
    testAuth.authenticated = true;
    const { container } = renderBare();
    expect(await screen.findByRole("button", { name: "Fit" })).toBeInTheDocument();
    expect(container.querySelector(".app-shell")).toHaveClass("app-shell--bare");
    expect(container.querySelector(".sidebar, header, footer, .tabbar")).toBeNull();
  });

  it("keeps the tab bar for signed-in users on phones", async () => {
    testAuth.authenticated = true;
    viewport("phone");
    renderBare();
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(document.querySelector("header")).toBeNull();
  });
});

describe("Layout across breakpoints", () => {
  function Counter() {
    const [count, setCount] = useState(0);
    return (
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        {`Clicked ${count}`}
      </button>
    );
  }

  it("keeps the page mounted when the shell switches between phone, tablet and desktop", async () => {
    testAuth.authenticated = true;
    const media = viewport("phone");
    const { container } = renderShell("/library", <Counter />);
    await screen.findByRole("navigation", { name: "Primary" });
    const button = screen.getByRole("button", { name: "Clicked 0" });
    fireEvent.click(button);

    for (const kind of ["desktop", "tablet", "phone"] as const) {
      act(() => media.set(matcher(kind)));
      expect(container.querySelector(".sidebar")).toEqual(kind === "phone" ? null : expect.anything());
      // Same node, same state: rotating a phone never loses the page.
      expect(screen.getByRole("button", { name: "Clicked 1" })).toBe(button);
    }
  });
});

describe("Pages that hide the shell's top bars", () => {
  function Bare() {
    useShellChrome({ topBar: false, mobileTopBar: false });
    return (
      <TopBarActions>
        <button type="button">Import DOIs</button>
      </TopBarActions>
    );
  }

  it("drops the desktop breadcrumb bar and renders page actions in place", async () => {
    testAuth.authenticated = true;
    const { container } = renderShell("/settings", <Bare />);
    await screen.findByRole("complementary", { name: "Sidebar" });
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(container.querySelector("main")).toContainElement(screen.getByRole("button", { name: "Import DOIs" }));
    expect(container.querySelector(".app-shell")).toHaveClass("app-shell--no-topbar");
  });

  it("drops the phone app bar but keeps the tab bar", async () => {
    testAuth.authenticated = true;
    viewport("phone");
    const { container } = renderShell("/search", <Bare />);
    await screen.findByRole("navigation", { name: "Primary" });
    const shell = container.querySelector(".app-shell")!;
    expect(Array.from(shell.children).map((el) => el.tagName)).toEqual(["MAIN", "FOOTER", "NAV"]);
    expect(within(shell.querySelector("main")!).getByRole("button", { name: "Import DOIs" })).toBeInTheDocument();
  });

  it("restores the bars on the next page", async () => {
    testAuth.authenticated = true;
    function Switch() {
      const [hidden, setHidden] = useState(true);
      return hidden ? <><Bare /><button type="button" onClick={() => setHidden(false)}>Leave</button></> : <p>Next</p>;
    }
    const { container } = renderShell("/settings", <Switch />);
    fireEvent.click(await screen.findByRole("button", { name: "Leave" }));
    expect(await screen.findByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    expect(container.querySelector(".app-shell")).not.toHaveClass("app-shell--no-topbar");
  });
});
