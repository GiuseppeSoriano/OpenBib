import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
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
});

it("links to the open-source repository from the footer", () => {
  renderWithProviders(<Layout />);
  expect(screen.getByRole("link", { name: "Open source · Contribute on GitHub" })).toHaveAttribute("href", "https://github.com/GiuseppeSoriano/OpenBib");
});
