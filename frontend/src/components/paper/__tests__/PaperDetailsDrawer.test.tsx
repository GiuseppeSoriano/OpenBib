import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import PaperDetailsDrawer from "@/components/paper/PaperDetailsDrawer";
import { renderWithProviders } from "@/test/utils";
import type { PaperDetail } from "@/types";

const detail: PaperDetail = {
  canonical_key: "doi:10.1/drawer",
  paper_group_key: "group:drawer",
  title: "Drawer Paper",
  authors: [{ name: "Carol White", openalex_id: null, orcid: null, affiliations: [] }],
  abstract: "The full abstract of the drawer paper.",
  publication_date: "2023-06-15",
  doi: "10.1/drawer",
  arxiv_id: "2306.00001",
  pmid: null,
  pmcid: null,
  openalex_id: null,
  venue: "Conference of Drawers",
  volume: null,
  issue: null,
  pages: null,
  paper_type: "journal-article",
  topics: ["Databases"],
  keywords: [],
  open_access: true,
  pdf_url: null,
  abstract_url: null,
  cited_by_count: 7,
  reference_count: 30,
  version: null,
  provider_source: "openalex",
  provider_sources: ["openalex"],
  versions: [],
};

vi.mock("@/lib/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  papers: { getDetail: vi.fn(() => Promise.resolve(detail)) },
  library: { listKeys: vi.fn(() => Promise.resolve([])) },
  notes: { listForPaperGroup: vi.fn(() => Promise.resolve([])) },
  graph: {},
}));

describe("PaperDetailsDrawer", () => {
  it("renders full metadata for the requested paper", async () => {
    renderWithProviders(
      <PaperDetailsDrawer paperKey="doi:10.1/drawer" onClose={() => {}} />,
    );

    expect(await screen.findByText("Drawer Paper")).toBeInTheDocument();
    expect(screen.getByText("Carol White")).toBeInTheDocument();
    expect(screen.getByText("The full abstract of the drawer paper.")).toBeInTheDocument();
    expect(screen.getByText(/DOI: 10.1\/drawer/)).toBeInTheDocument();
    expect(screen.getByText(/arXiv: 2306.00001/)).toBeInTheDocument();
    expect(screen.getByText("7 citations")).toBeInTheDocument();
    expect(screen.getByText("30 references")).toBeInTheDocument();
  });

  it("shows a sign-in prompt instead of actions for anonymous users", async () => {
    renderWithProviders(
      <PaperDetailsDrawer paperKey="doi:10.1/drawer" onClose={() => {}} />,
    );

    await screen.findByText("Drawer Paper");
    expect(
      screen.getByText("Sign in to save this paper, track your reading state, and take notes."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("reading-state-select")).toBeNull();
    expect(screen.queryByTestId("tag-editor")).toBeNull();
  });

  it("renders nothing while closed", () => {
    renderWithProviders(<PaperDetailsDrawer paperKey={null} onClose={() => {}} />);
    expect(screen.queryByTestId("paper-details")).toBeNull();
  });
});
