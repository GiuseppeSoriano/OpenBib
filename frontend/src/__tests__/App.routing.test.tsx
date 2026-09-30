import { useLocation } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import App from "@/App";
import { renderWithProviders } from "@/test/utils";

describe("App routing (anonymous)", () => {
  it("shows the search-first landing page at the root", async () => {
    renderWithProviders(<App />, { route: "/" });
    expect(
      await screen.findByText("Discover, organize, and explore research papers"),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search millions of papers by title, author, DOI…"),
    ).toBeInTheDocument();
  });

  it("keeps the search page public", async () => {
    renderWithProviders(<App />, { route: "/search" });
    expect(await screen.findByPlaceholderText("Search by title, author, DOI, keyword…")).toBeInTheDocument();
  });

  it("redirects anonymous users from the library to login", async () => {
    renderWithProviders(<App />, { route: "/library" });
    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
  });

  it("redirects anonymous users from settings to login", async () => {
    renderWithProviders(<App />, { route: "/settings" });
    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="destination">{location.state?.returnTo}</output>;
}

it.each(["/library?focus=group%3Atest#anchor", "/settings?section=security#password"])("preserves the complete destination for %s", async (route) => {
  renderWithProviders(<><App /><LocationProbe /></>, { route });
  await screen.findByText("Welcome back");
  expect(screen.getByTestId("destination")).toHaveTextContent(route);
});
