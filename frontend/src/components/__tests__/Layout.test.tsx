import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import Layout from "@/components/Layout";
import { renderWithProviders } from "@/test/utils";

describe("Layout", () => {
  it("renders the main navigation", async () => {
    renderWithProviders(<Layout />);
    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Collections")).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });
});
