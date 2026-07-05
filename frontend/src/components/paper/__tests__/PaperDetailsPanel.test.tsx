import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import { renderWithProviders } from "@/test/utils";
import type { PaperDetail } from "@/types";

const detail: PaperDetail = {
  canonical_key: "doi:10.1/panel",
  paper_group_key: "group:panel",
  title: "Panel Paper",
  authors: [{ name: "Carol White", openalex_id: null, orcid: null, affiliations: [] }],
  abstract: "The full abstract of the panel paper.",
  publication_date: "2023-06-15",
  doi: "10.1/panel",
  arxiv_id: "2306.00001",
  pmid: null,
  pmcid: null,
  openalex_id: null,
  venue: "Conference of Panels",
  volume: null,
  issue: null,
  pages: null,
  paper_type: "journal-article",
  topics: ["Databases"],
  keywords: [],
  open_access: true,
  pdf_url: "https://example.org/panel.pdf",
  abstract_url: null,
  cited_by_count: 7,
  reference_count: 30,
  version: null,
  provider_source: "openalex",
  provider_sources: ["openalex"],
  versions: [],
};

vi.mock("@/lib/api", () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  papers: { getDetail: vi.fn(() => Promise.resolve(detail)) },
  library: { listKeys: vi.fn(() => Promise.resolve([])) },
  notes: { listForPaperGroup: vi.fn(() => Promise.resolve([])) },
  graph: {},
  zotero: {},
}));

describe("PaperDetailsPanel", () => {
  it("renders human-readable metadata for the requested paper", async () => {
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);

    expect(await screen.findByText("Panel Paper")).toBeInTheDocument();
    expect(screen.getByText("Carol White")).toBeInTheDocument();
    expect(screen.getByText("The full abstract of the panel paper.")).toBeInTheDocument();
    expect(screen.getByText("7 citations")).toBeInTheDocument();
    expect(screen.getByText("30 references")).toBeInTheDocument();
  });

  it("shows links as chips and never exposes raw identifiers", async () => {
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);
    await screen.findByText("Panel Paper");

    // Link chips exist with human labels + correct hrefs…
    const publisher = screen.getByRole("link", { name: /Publisher/ });
    expect(publisher).toHaveAttribute("href", "https://doi.org/10.1/panel");
    const arxiv = screen.getByRole("link", { name: /arXiv/ });
    expect(arxiv).toHaveAttribute("href", "https://arxiv.org/abs/2306.00001");
    expect(screen.getByRole("link", { name: /PDF/ })).toBeInTheDocument();

    // …but no raw DOI / arXiv id / canonical key text anywhere.
    expect(screen.queryByText(/10\.\d{2,}/)).toBeNull();
    expect(screen.queryByText(/2306\.00001/)).toBeNull();
    expect(screen.queryByText(/doi:/)).toBeNull();
  });

  it("shows a sign-in prompt instead of actions for anonymous users", async () => {
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);
    await screen.findByText("Panel Paper");

    expect(
      screen.getByText("Sign in to save this paper, track your reading state, and take notes."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("reading-state-select")).toBeNull();
    expect(screen.queryByTestId("add-to-collection")).toBeNull();
  });

  it("renders nothing while closed", () => {
    renderWithProviders(<PaperDetailsPanel paperKey={null} onClose={() => {}} />);
    expect(screen.queryByTestId("paper-details")).toBeNull();
  });
});
