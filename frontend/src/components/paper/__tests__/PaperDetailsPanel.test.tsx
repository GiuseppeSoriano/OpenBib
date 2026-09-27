import { testAuth, mockRefresh } from "@/test/auth-mock";
import { describe, it, expect, vi } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
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
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
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

describe("PaperDetailsPanel — dialog accessibility", () => {
  it("is named after the paper and has a localized close button", async () => {
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);

    expect(
      await screen.findByRole("dialog", { name: /Paper details.*Panel Paper/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage("it");
    });
    expect(screen.getByRole("dialog", { name: /Dettagli articolo.*Panel Paper/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chiudi" })).toBeInTheDocument();
  });

  it("closes only the add-to-collection menu on Escape", async () => {
    testAuth.authenticated = true;
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={onClose} />);

    const trigger = await screen.findByTestId("add-to-collection");
    await user.click(trigger);
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the menu on Escape when focus fell back to the body", async () => {
    testAuth.authenticated = true;
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={onClose} />);

    await user.click(await screen.findByTestId("add-to-collection"));
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    // A clicked menu item that becomes disabled drops focus to <body>.
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not close on Escape while a note draft is being typed", async () => {
    testAuth.authenticated = true;
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={onClose} />);

    const note = within(await screen.findByTestId("notes-panel")).getByRole("textbox");
    await user.type(note, "A thought worth keeping");
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    await user.clear(note);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
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
    testAuth.authenticated = true;
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

  it("gives the version icon buttons accessible names", async () => {
    setupLibraryPaper();
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);
    const section = await screen.findByTestId("managed-versions");

    expect(
      within(section).getByRole("button", { name: "Make this version the default shown" }),
    ).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Remove this version pin" })).toBeInTheDocument();
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
