import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import LibraryPage from "@/pages/LibraryPage";
import { renderWithProviders } from "@/test/utils";
import type { PaperMetadata } from "@/types";

function paper(key: string, title: string): PaperMetadata {
  return {
    canonical_key: key,
    paper_group_key: `group:${key}`,
    title,
    authors: [{ name: "Alice Smith", openalex_id: null, orcid: null, affiliations: [] }],
    abstract: null,
    publication_date: "2020-01-01",
    doi: "10.1234/secret",
    arxiv_id: null,
    pmid: null,
    pmcid: null,
    openalex_id: null,
    venue: "ICML",
    volume: null,
    issue: null,
    pages: null,
    paper_type: null,
    topics: [],
    keywords: [],
    open_access: true,
    pdf_url: null,
    abstract_url: null,
    cited_by_count: 42,
    reference_count: null,
    version: null,
    provider_source: "openalex",
    provider_sources: ["openalex"],
  };
}

const entries = [
  {
    paper_group_key: "group:doi:10.1/a",
    primary_canonical_key: "doi:10.1/a",
    created_at: "2026-01-01T00:00:00Z",
    primary_version: paper("doi:10.1/a", "First Library Paper"),
    version_count: 2,
    tags: ["ml", "survey"],
  },
  {
    paper_group_key: "group:doi:10.1/b",
    primary_canonical_key: "doi:10.1/b",
    created_at: "2026-01-02T00:00:00Z",
    primary_version: paper("doi:10.1/b", "Second Library Paper"),
    version_count: 1,
    tags: [],
  },
];

vi.mock("@/lib/api", () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  library: {
    listEntries: vi.fn(() => Promise.resolve(entries)),
    listKeys: vi.fn(() => Promise.resolve([])),
    getEntry: vi.fn(),
    deleteEntry: vi.fn(),
  },
  papers: {
    getDetail: vi.fn(() =>
      Promise.resolve({ ...entries[0]!.primary_version, versions: [] }),
    ),
  },
  notes: { listForPaperGroup: vi.fn(() => Promise.resolve([])) },
  graph: {},
  zotero: {
    getStatus: vi.fn(() =>
      Promise.resolve({ connected: false, zotero_user_id: null, api_key_masked: null }),
    ),
    syncLibrary: vi.fn(),
  },
}));

describe("LibraryPage", () => {
  it("renders rich human-readable entries", async () => {
    renderWithProviders(<LibraryPage />, { route: "/library" });

    expect(await screen.findByText("First Library Paper")).toBeInTheDocument();
    expect(screen.getByText("Second Library Paper")).toBeInTheDocument();
    expect(screen.getAllByText(/ICML · 2020 · 42 citations/)).toHaveLength(2);
    expect(screen.getByText("ml")).toBeInTheDocument();
    expect(screen.getByText("2 versions")).toBeInTheDocument();
  });

  it("exposes no low-level identifiers or accordion toggles", async () => {
    const { container } = renderWithProviders(<LibraryPage />, { route: "/library" });
    await screen.findByText("First Library Paper");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/doi:10\./);
    expect(text).not.toMatch(/hash:/);
    expect(text).not.toMatch(/10\.1234\/secret/);
    expect(screen.queryByText("View details")).toBeNull();
    expect(screen.queryByText("Hide details")).toBeNull();
    expect(container.querySelector("code")).toBeNull();
  });

  it("offers add-to-collection on every entry", async () => {
    renderWithProviders(<LibraryPage />, { route: "/library" });
    await screen.findByText("First Library Paper");
    expect(screen.getAllByTestId("add-to-collection")).toHaveLength(2);
  });

  it("opens the details panel when an entry is clicked", async () => {
    renderWithProviders(<LibraryPage />, { route: "/library" });
    fireEvent.click(await screen.findByText("First Library Paper"));
    expect(await screen.findByTestId("paper-details")).toBeInTheDocument();
  });

  it("opens the details panel from a ?focus= deep link", async () => {
    renderWithProviders(<LibraryPage />, {
      route: "/library?focus=group%3Adoi%3A10.1%2Fb",
    });
    expect(await screen.findByTestId("paper-details")).toBeInTheDocument();
  });
});
