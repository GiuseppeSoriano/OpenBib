import { testAuth, mockRefresh } from "@/test/auth-mock";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import api from "@/lib/api";
import Layout from "@/components/Layout";
import LanguageMenu from "@/components/nav/LanguageMenu";
import { renderWithProviders } from "@/test/utils";

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

describe("UserMenu", () => {
  it("waits for server logout and reports failures without pretending revocation succeeded", async () => {
    testAuth.authenticated = true;
    vi.mocked(api.post).mockRejectedValueOnce(new Error("offline"));
    renderWithProviders(<Layout />);
    fireEvent.click(await screen.findByTestId("user-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Logout/ }));
    expect(await screen.findByText(/session is still active/i)).toBeInTheDocument();
    expect(screen.getByTestId("user-menu")).toBeInTheDocument();
  });

  it("removes the account menu only after successful server revocation", async () => {
    testAuth.authenticated = true;
    vi.mocked(api.post).mockResolvedValueOnce({ data: undefined });
    renderWithProviders(<Layout />);
    fireEvent.click(await screen.findByTestId("user-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Logout/ }));
    expect(await screen.findByRole("link", { name: /Sign in/i })).toBeInTheDocument();
    expect(screen.queryByTestId("user-menu")).toBeNull();
  });

  it("opens the account menu with settings and logout when authenticated", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<Layout />);

    const trigger = await screen.findByTestId("user-menu");
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("me@example.com")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Settings/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Logout/ })).toBeInTheDocument();
    // Theme and language moved here from the signed-in header.
    expect(within(menu).getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemradio", { name: /System/ })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: /English/ })).toHaveAttribute("aria-checked", "true");
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
