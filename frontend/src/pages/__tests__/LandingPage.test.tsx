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

  it("links example queries straight to the search results", () => {
    show();
    const examples = screen.getByRole("list", { name: "Try" });
    const links = within(examples).getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(3);
    expect(within(examples).getByRole("link", { name: "graph neural networks" })).toHaveAttribute(
      "href",
      "/search?q=graph%20neural%20networks",
    );
    fireEvent.click(within(examples).getByRole("link", { name: "CRISPR gene editing" }));
    expect(screen.getByText("at /search?q=CRISPR%20gene%20editing")).toBeInTheDocument();
  });

  it("offers both ways in, in the hero and in the closing band", () => {
    show();
    const hero = screen.getByRole("region", { name: "Discover, organize, and explore research papers" });
    expect(within(hero).getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
    expect(within(hero).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    const cta = screen.getByRole("region", { name: "Start your reading list" });
    expect(within(cta).getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
    expect(within(cta).getByRole("link", { name: "Search papers" })).toHaveAttribute("href", "/search");
  });

  it("lists the features with decorative icons under their own headings", () => {
    show();
    const features = screen.getByRole("region", { name: "What OpenBib does" });
    const items = within(features).getAllByRole("listitem");
    expect(items.map((item) => within(item).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "Search the literature",
      "Library and reading states",
      "Collections and sharing",
      "Citation graph",
      "Import by identifier",
      "Zotero sync and export",
    ]);
    for (const item of items) {
      expect(item.querySelector("svg")?.closest("[aria-hidden='true']")).not.toBeNull();
    }
  });

  it("explains the three steps in order and states the trust facts", () => {
    show();
    const how = screen.getByRole("region", { name: "How it works" });
    const steps = within(how).getAllByRole("listitem");
    expect(within(how).getByRole("list").tagName).toBe("OL");
    expect(steps.map((step) => within(step).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "Search",
      "Save and organize",
      "Explore and share",
    ]);
    const trust = screen.getByRole("region", { name: "Built in the open" });
    expect(within(trust).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Semantic Scholar data",
      "Open source",
      "No tracking",
      "Your data stays yours",
    ]);
  });

  it("keeps one h1 and hides the decorative network from assistive technology", () => {
    const { container } = show();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const motif = container.querySelector(".landing-motif");
    expect(motif).toHaveAttribute("aria-hidden", "true");
    expect(motif).toHaveAttribute("focusable", "false");
  });
});
