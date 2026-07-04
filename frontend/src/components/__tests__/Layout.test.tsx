import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import Layout from "@/components/Layout";
import { renderWithProviders } from "@/test/utils";

describe("Layout", () => {
  it("renders the main navigation in the sidebar and bottom nav", async () => {
    renderWithProviders(<Layout />);
    // Each nav item renders twice: desktop sidebar + mobile bottom nav.
    for (const label of ["Dashboard", "Search", "Collections", "Library", "Settings"]) {
      expect(await screen.findAllByText(label)).toHaveLength(2);
    }
  });

  it("shows a sign-in link when no user is authenticated", async () => {
    renderWithProviders(<Layout />);
    expect(await screen.findByText("Sign in")).toBeInTheDocument();
  });
});
