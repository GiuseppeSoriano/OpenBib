import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import LandingPage from "@/pages/LandingPage";

function SearchProbe() {
  const location = useLocation();
  return <p>{`at ${location.pathname}${location.search}`}</p>;
}

function show() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/search" element={<SearchProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("landing page", () => {
  it("leads with a serif headline and a labelled search field", () => {
    show();
    expect(screen.getByRole("heading", { level: 1, name: "Discover, organize, and explore research papers" })).toBeInTheDocument();
    const search = screen.getByRole("search");
    const field = within(search).getByLabelText("Search terms");
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("aria-keyshortcuts", "/");
    // The "/" hint is visual only; the shortcut is announced on the field.
    expect(search.querySelector("kbd")).toHaveAttribute("aria-hidden", "true");
  });

  it("searches for the trimmed query and ignores an empty one", () => {
    show();
    const field = screen.getByLabelText("Search terms");
    fireEvent.submit(field.closest("form")!);
    expect(screen.getByRole("search")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "  graph neural networks " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByText("at /search?q=graph%20neural%20networks")).toBeInTheDocument();
  });

  it("offers both ways in and lists the features as ruled rows", () => {
    show();
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    const features = screen.getByRole("region", { name: "What OpenBib does" });
    const rows = within(features).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => within(row).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "Paper search",
      "Citation graph",
      "Personal library",
    ]);
  });
});
