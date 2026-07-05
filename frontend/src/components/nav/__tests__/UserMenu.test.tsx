import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Layout from "@/components/Layout";
import LanguageMenu from "@/components/nav/LanguageMenu";
import { renderWithProviders } from "@/test/utils";

vi.mock("@/lib/api", () => ({
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
  it("opens the account menu with settings and logout when authenticated", async () => {
    localStorage.setItem("access_token", "test-token");
    renderWithProviders(<Layout />);

    const trigger = await screen.findByTestId("user-menu");
    fireEvent.click(trigger);

    expect(await screen.findByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Settings/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Logout/ })).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    localStorage.setItem("access_token", "test-token");
    renderWithProviders(<Layout />);

    fireEvent.click(await screen.findByTestId("user-menu"));
    expect(await screen.findByText("me@example.com")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("me@example.com")).toBeNull();
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
