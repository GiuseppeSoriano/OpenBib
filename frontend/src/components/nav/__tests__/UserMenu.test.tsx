import { testAuth, mockRefresh } from "@/test/auth-mock";
import { afterEach, describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import api from "@/lib/api";
import Layout from "@/components/Layout";
import LanguageMenu from "@/components/nav/LanguageMenu";
import { PHONE_QUERY, RAIL_QUERY } from "@/lib/breakpoints";
import { mockMatchMedia, renderWithProviders, restoreMatchMedia } from "@/test/utils";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn((url: string) => {
      if (url === "/users/me")
        return Promise.resolve({
          data: { id: "u1", email: "me@example.com", display_name: "Ada", created_at: "2026-01-01" },
        });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  papers: {},
  library: {},
  notes: {},
  graph: {},
  zotero: {},
}));

afterEach(() => restoreMatchMedia());

describe("UserMenu", () => {
  it("waits for server logout and reports failures without pretending revocation succeeded", async () => {
    testAuth.authenticated = true;
    mockMatchMedia((query) => query === PHONE_QUERY || query === RAIL_QUERY);
    vi.mocked(api.post).mockRejectedValueOnce(new Error("offline"));
    renderWithProviders(<Layout />);
    fireEvent.click(await screen.findByTestId("user-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByText(/session is still active/i)).toBeInTheDocument();
    expect(screen.getByTestId("user-menu")).toBeInTheDocument();
  });

  it("removes the account menu only after successful server revocation", async () => {
    testAuth.authenticated = true;
    mockMatchMedia((query) => query === PHONE_QUERY || query === RAIL_QUERY);
    vi.mocked(api.post).mockResolvedValueOnce({ data: undefined });
    renderWithProviders(<Layout />);
    fireEvent.click(await screen.findByTestId("user-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: /Sign in/i })).toBeInTheDocument();
    expect(screen.queryByTestId("user-menu")).toBeNull();
  });

  it("leaves Settings and Sign out to the sidebar, each in one place", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<Layout />);

    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    expect(within(sidebar).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
    fireEvent.click(await within(sidebar).findByTestId("user-menu"));

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("me@example.com")).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Settings/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Sign out" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
    // Theme and language moved here from the signed-in header.
    expect(within(menu).getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemradio", { name: /System/ })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: /English/ })).toHaveAttribute("aria-checked", "true");
  });

  it("keeps Settings in the avatar menu on phones, where there is no sidebar", async () => {
    testAuth.authenticated = true;
    mockMatchMedia((query) => query === PHONE_QUERY || query === RAIL_QUERY);
    renderWithProviders(<Layout />);

    fireEvent.click(await screen.findByTestId("user-menu"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Settings/ })).toHaveAttribute("href", "/settings");
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-signout")).toBeNull();
  });

  it("signs out from the labelled sidebar row", async () => {
    testAuth.authenticated = true;
    vi.mocked(api.post).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ data: undefined });
    renderWithProviders(<Layout />);

    const signOut = await screen.findByRole("button", { name: "Sign out" });
    expect(signOut).toHaveTextContent("Sign out");
    fireEvent.click(signOut);
    expect(await screen.findByText(/session is still active/i)).toBeInTheDocument();
    expect(screen.getByTestId("user-menu")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: /Sign in/i })).toBeInTheDocument();
    expect(screen.queryByTestId("user-menu")).toBeNull();
  });

  it("ignores repeat clicks while a sign-out is in flight", async () => {
    testAuth.authenticated = true;
    vi.mocked(api.post).mockClear();
    let finish: (value: { data: undefined }) => void = () => {};
    vi.mocked(api.post).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    renderWithProviders(<Layout />);

    const signOut = await screen.findByRole("button", { name: "Sign out" });
    fireEvent.click(signOut);
    fireEvent.click(signOut);
    await waitFor(() => expect(signOut).toHaveAttribute("aria-busy", "true"));
    expect(signOut).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(signOut);

    finish({ data: undefined });
    expect(await screen.findByRole("link", { name: /Sign in/i })).toBeInTheDocument();
    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === "/auth/logout")).toHaveLength(1);
    expect(screen.queryByText(/session is still active/i)).toBeNull();
  });

  it("closes on Escape", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<Layout />);

    const trigger = await screen.findByTestId("user-menu");
    fireEvent.click(trigger);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("switches the theme from the account menu", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<Layout />);
    fireEvent.click(await screen.findByTestId("user-menu"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Dark/ }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("openbib.theme")).toBe("dark");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("LanguageMenu", () => {
  it("switches to Italian and persists the choice", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LanguageMenu />);

    await user.click(screen.getByTestId("language-menu"));
    await user.click(await screen.findByRole("menuitemradio", { name: /Italiano/ }));

    expect(localStorage.getItem("openbib.lang")).toBe("it");
    expect(document.documentElement.lang).toBe("it");
  });
});
