import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
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

const libState: {
  keys: string[];
  entry: unknown;
} = { keys: [], entry: null };

const repinPrimary = vi.fn(() => Promise.resolve({}));
const removeVersion = vi.fn(() => Promise.resolve());

vi.mock("@/lib/api", () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === "/users/me")
        return Promise.resolve({
          data: { id: "u1", email: "me@example.com", display_name: "Me", created_at: "2026-01-01" },
        });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  papers: { getDetail: vi.fn(() => Promise.resolve(detail)) },
  library: {
    listKeys: vi.fn(() => Promise.resolve(libState.keys)),
    getEntry: vi.fn(() => Promise.resolve(libState.entry)),
    ensureEntry: vi.fn(),
    repinPrimary: (...args: unknown[]) => repinPrimary(...(args as [])),
    removeVersion: (...args: unknown[]) => removeVersion(...(args as [])),
  },
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

describe("PaperDetailsPanel — managed library versions", () => {
  function setupLibraryPaper() {
    libState.keys = ["group:panel"];
    libState.entry = {
      paper_group_key: "group:panel",
      primary_canonical_key: "doi:10.1/panel",
      created_at: "2026-01-01T00:00:00Z",
      primary_version: detail,
      pinned_versions: [
        {
          paper_canonical_key: "doi:10.1/panel",
          paper_group_key: "group:panel",
          source_provider: "crossref",
          added_at: "2026-01-01T00:00:00Z",
        },
        {
          paper_canonical_key: "hash:preprint1",
          paper_group_key: "group:panel",
          source_provider: "arxiv",
          added_at: "2026-01-02T00:00:00Z",
        },
      ],
      notes_count: 0,
      tags: [],
      states: [],
    };
    localStorage.setItem("access_token", "test-token");
    repinPrimary.mockClear();
    removeVersion.mockClear();
  }

  it("shows humanized managed pins with a primary badge", async () => {
    setupLibraryPaper();
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);

    const section = await screen.findByTestId("managed-versions");
    expect(section).toHaveTextContent("Pinned versions");
    expect(section).toHaveTextContent("Primary");
    // Pin without matching metadata degrades to the provider label — never a raw key.
    expect(section).toHaveTextContent("arXiv");
    expect(section.textContent).not.toMatch(/hash:|doi:/);
  });

  it("repins and removes versions through the panel", async () => {
    setupLibraryPaper();
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);
    const section = await screen.findByTestId("managed-versions");

    const [repinBtn] = within(section).getAllByTitle("Make this version the default shown");
    fireEvent.click(repinBtn!);
    await waitFor(() =>
      expect(repinPrimary).toHaveBeenCalledWith("group:panel", "hash:preprint1"),
    );

    const [removeBtn] = within(section).getAllByTitle("Remove this version pin");
    fireEvent.click(removeBtn!);
    await waitFor(() =>
      expect(removeVersion).toHaveBeenCalledWith("group:panel", "hash:preprint1"),
    );
  });
});
