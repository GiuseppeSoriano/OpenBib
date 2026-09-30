import { describe, it, expect } from "vitest";
import { act, screen, within } from "@testing-library/react";
import i18n from "@/i18n";
import Layout from "@/components/Layout";
import { renderWithProviders } from "@/test/utils";

describe("Layout (top navbar shell)", () => {
  it("renders the primary navigation in the navbar and bottom tab bar", async () => {
    renderWithProviders(<Layout />);
    // Each destination renders twice: TopNav links + mobile tab bar.
    for (const label of ["Dashboard", "Search", "Collections", "Library"]) {
      expect(await screen.findAllByText(label)).toHaveLength(2);
    }
  });

  it("has no sidebar, drawer, or hamburger button", () => {
    const { container } = renderWithProviders(<Layout />);
    expect(container.querySelector(".sidebar")).toBeNull();
    expect(container.querySelector(".topbar-menu")).toBeNull();
    expect(container.querySelector(".drawer")).toBeNull();
  });

  it("shows a sign-in button instead of the user menu when anonymous", async () => {
    renderWithProviders(<Layout />);
    expect(await screen.findByText("Sign in")).toBeInTheDocument();
    expect(screen.queryByTestId("user-menu")).toBeNull();
  });

  it("orders main, footer links, then the tab bar so the footer is cleared (F03)", async () => {
    const { container } = renderWithProviders(<Layout />);
    await screen.findByText("Sign in");
    const shell = container.querySelector(".app-shell")!;
    expect(Array.from(shell.children).map((el) => el.tagName)).toEqual([
      "HEADER",
      "MAIN",
      "FOOTER",
      "NAV",
    ]);

    const footer = shell.querySelector("footer")!;
    expect(within(footer).getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(within(footer).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(shell.lastElementChild).toHaveClass("tabbar");
  });

  it("labels both primary navigations in the current language", async () => {
    renderWithProviders(<Layout />);
    expect(await screen.findAllByRole("navigation", { name: "Primary" })).toHaveLength(2);
    await act(async () => {
      await i18n.changeLanguage("it");
    });
    expect(screen.getAllByRole("navigation", { name: "Principale" })).toHaveLength(2);
  });
});

it("links to the open-source repository from the footer", () => {
  renderWithProviders(<Layout />);
  expect(screen.getByRole("link", { name: /Contribute on GitHub/ })).toHaveAttribute("href", "https://github.com/GiuseppeSoriano/OpenBib");
});
