import { testAuth, mockRefresh } from "@/test/auth-mock";
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import { library, papers } from "@/lib/api";
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

// Tests that need other metadata swap this and restore `detail` afterwards.
const detailState: { current: PaperDetail } = { current: detail };

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
  papers: {
    getDetail: vi.fn(() => Promise.resolve(detailState.current)),
    getStates: vi.fn(() => Promise.resolve([])),
    setState: vi.fn((key: string, state: string) => Promise.resolve({ paper_canonical_key: key, state })),
  },
  library: {
    listKeys: vi.fn(() => Promise.resolve(libState.keys)),
    getEntry: vi.fn(() => Promise.resolve(libState.entry)),
    ensureEntry: vi.fn(),
    repinPrimary: (...args: unknown[]) => repinPrimary(...(args as [])),
    removeVersion: (...args: unknown[]) => removeVersion(...(args as [])),
    resolve: vi.fn(() =>
      Promise.resolve({
        status: "resolved",
        previous_key: "10.1/PANEL",
        canonical_key: "doi:10.1/panel",
        paper_group_key: "group:panel",
        paper: null,
        moved: {},
      }),
    ),
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

  it("sets the reading state from a popover that closes alone on Escape", async () => {
    testAuth.authenticated = true;
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={onClose} />);

    const chip = await screen.findByRole("button", { name: "Reading state: No state" });
    await user.click(chip);
    expect(screen.getByRole("listbox", { name: "Reading state" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(chip).toHaveFocus();

    await user.click(chip);
    await user.click(screen.getByRole("option", { name: "To read" }));
    expect(papers.setState).toHaveBeenCalledWith("doi:10.1/panel", "to_read");
    await waitFor(() => expect(chip).toHaveAccessibleName("Reading state: To read"));
    expect(chip).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
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

  it("shows humanized saved versions with a default-version badge", async () => {
    setupLibraryPaper();
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);

    const section = await screen.findByTestId("managed-versions");
    expect(section).toHaveTextContent("Saved versions");
    expect(section).toHaveTextContent("Default version");
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
    expect(within(section).getByRole("button", { name: "Remove this saved version" })).toBeInTheDocument();
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

    const [removeBtn] = within(section).getAllByTitle("Remove this saved version");
    fireEvent.click(removeBtn!);
    await waitFor(() =>
      expect(removeVersion).toHaveBeenCalledWith("group:panel", "hash:preprint1"),
    );
  });
});

describe("PaperDetailsPanel — provider text, links and versions", () => {
  afterEach(() => {
    detailState.current = detail;
  });

  function renderDetail(overrides: Partial<PaperDetail>) {
    detailState.current = { ...detail, ...overrides };
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);
  }

  it("renders a raw structured abstract as paragraphs with bold labels", async () => {
    renderDetail({ abstract: "<h4>Background</h4>Odor coding.<h4>Results</h4>It works <i>well</i>." });
    const details = await screen.findByTestId("paper-details");

    const paragraphs = details.querySelectorAll(".pd-abstract p");
    expect(paragraphs).toHaveLength(2);
    expect(within(paragraphs[0] as HTMLElement).getByText("Background:").tagName).toBe("STRONG");
    expect(paragraphs[0]).toHaveTextContent("Background: Odor coding.");
    expect(within(paragraphs[1] as HTMLElement).getByText("Results:").tagName).toBe("STRONG");
    expect(paragraphs[1]).toHaveTextContent("Results: It works well.");
    expect(details.textContent).not.toMatch(/<h4|<i>|<\/?[a-z]+>/);
  });

  it("keeps tag-like literal text in an abstract", async () => {
    const abstract = "Rust Box<T> values and <mask> tokens hold when x<a and y>b.";
    renderDetail({ abstract });
    const details = await screen.findByTestId("paper-details");

    const paragraphs = details.querySelectorAll(".pd-abstract p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.textContent).toBe(abstract);
  });

  it("shows a Semantic Scholar record's page as its own link, never as full text", async () => {
    const page = "https://www.semanticscholar.org/paper/3efd851140aa28e95221b55fcc5659eea97b172d";
    const figshare =
      "https://figshare.com/articles/journal_contribution/The_graph_neural_network_model/27757629";
    renderDetail({
      canonical_key: "s2:3efd851140aa28e95221b55fcc5659eea97b172d",
      semantic_scholar_id: "3efd851140aa28e95221b55fcc5659eea97b172d",
      pmid: "19068426",
      pdf_url: figshare,
      abstract_url: page,
      provider_source: "semantic_scholar",
      provider_sources: ["semantic_scholar"],
    });
    const details = await screen.findByTestId("paper-details");

    const fullText = screen.getByRole("link", { name: /Full text \/ Repository/ });
    expect(fullText).toHaveAttribute("href", figshare);
    expect(screen.queryByRole("link", { name: /Download PDF/ })).toBeNull();
    const s2 = screen.getByRole("link", { name: "View on Semantic Scholar (opens in a new tab)" });
    expect(s2).toHaveAttribute("href", page);
    expect(s2).toHaveAttribute("target", "_blank");
    expect(s2).toHaveAttribute("title", "semanticscholar.org");
    expect(s2.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(screen.getByRole("link", { name: /PubMed/ })).toHaveAttribute(
      "href",
      "https://pubmed.ncbi.nlm.nih.gov/19068426/",
    );
    const chips = within(details).getAllByRole("link").filter((link) => link.getAttribute("target") === "_blank");
    expect(chips.filter((link) => link.getAttribute("href") === page)).toHaveLength(1);
    expect(chips.map((link) => link.textContent?.replace(/\s*\(opens in a new tab\)$/, ""))).toEqual([
      "Publisher",
      "arXiv",
      "PubMed",
      "Full text / Repository",
      "View on Semantic Scholar",
    ]);
  });

  it("labels a real PDF as a download and a repository page as full text", async () => {
    renderDetail({
      pdf_url: "https://figshare.com/articles/journal_contribution/Panel/123",
      abstract_url: "https://europepmc.org/articles/PMC1?pdf=render",
    });
    await screen.findByText("Panel Paper");

    const pdf = screen.getByRole("link", { name: /Download PDF/ });
    expect(pdf).toHaveAttribute("href", "https://europepmc.org/articles/PMC1?pdf=render");
    const fullText = screen.getByRole("link", { name: /Full text \/ Repository/ });
    expect(fullText).toHaveAttribute(
      "href",
      "https://figshare.com/articles/journal_contribution/Panel/123",
    );
    expect(fullText).toHaveAttribute("title", "figshare.com");
  });

  it("marks every external chip as opening in a new tab", async () => {
    renderDetail({});
    await screen.findByText("Panel Paper");

    const links = within(screen.getByTestId("paper-details"))
      .getAllByRole("link")
      .filter((link) => link.getAttribute("target") === "_blank");
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link).toHaveAccessibleName(/\(opens in a new tab\)$/);
      expect(link.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link.getAttribute("title")).toBeTruthy();
    }
  });

  it("says which provider the citation count comes from", async () => {
    renderDetail({});
    expect(await screen.findByText("Citation count from OpenAlex")).toBeVisible();
  });

  it("distinguishes same-year versions without showing identifiers", async () => {
    const preprint = {
      ...detail,
      doi: null,
      arxiv_id: null,
      paper_type: "posted-content",
      provider_source: "crossref",
      publication_date: null,
      cited_by_count: null,
      venue: null,
      versions: undefined,
    };
    renderDetail({
      versions: [
        { ...preprint, canonical_key: "doi:10.20944/p.v1" },
        { ...preprint, canonical_key: "doi:10.20944/p.v2" },
      ],
    });
    await screen.findByText("Panel Paper");

    const items = screen.getAllByRole("listitem").filter((li) => li.className.includes("pd-version"));
    expect(items.map((li) => li.textContent)).toEqual([
      "Preprint · Crossref · 1 of 2Crossref",
      "Preprint · Crossref · 2 of 2Crossref",
    ]);
    expect(screen.getByTestId("paper-details").textContent).not.toMatch(/10\.20944|doi:/);
  });
});

describe("PaperDetailsPanel — load errors and re-resolution", () => {
  afterEach(() => {
    testAuth.authenticated = false;
    vi.mocked(papers.getDetail).mockImplementation(() => Promise.resolve(detailState.current));
    vi.mocked(library.resolve).mockClear();
  });

  it("explains a missing paper, links its DOI and retries", async () => {
    const user = userEvent.setup();
    vi.mocked(papers.getDetail).mockClear();
    vi.mocked(papers.getDetail).mockRejectedValueOnce({ response: { status: 404, data: { detail: "Paper not found" } } });
    renderWithProviders(<PaperDetailsPanel paperKey="10.1109/TNN.2008.2005605" onClose={() => {}} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No paper was found for this identifier.");
    expect(within(alert).getByRole("link", { name: /Open the DOI link/ })).toHaveAttribute(
      "href",
      "https://doi.org/10.1109/tnn.2008.2005605",
    );

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Panel Paper")).toBeInTheDocument();
    expect(papers.getDetail).toHaveBeenCalledTimes(2);
  });

  it("counts down a provider outage's Retry-After", async () => {
    vi.mocked(papers.getDetail).mockRejectedValueOnce({
      response: {
        status: 503,
        headers: { "retry-after": "30" },
        data: { detail: { code: "provider_rate_limited", message: "busy" } },
      },
    });
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Semantic Scholar is receiving too many requests. Try again in 30 s.",
    );
    expect(screen.queryByRole("link", { name: /Open the DOI link/ })).toBeNull();
  });

  it("shows a generic explanation for other failures", async () => {
    vi.mocked(papers.getDetail).mockRejectedValueOnce({ response: { status: 400 } });
    renderWithProviders(<PaperDetailsPanel paperKey="doi:10.1/panel" onClose={() => {}} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t load the paper details.");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("re-resolves an unresolved paper once for a signed-in user", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<PaperDetailsPanel paperKey="10.1/PANEL" onClose={() => {}} resolveOnOpen />);
    await screen.findByText("Panel Paper");

    await waitFor(() => expect(library.resolve).toHaveBeenCalledWith({ paper_canonical_key: "10.1/PANEL" }));
    // The lists it invalidates re-render the panel; it still resolves only once.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(library.resolve).toHaveBeenCalledTimes(1);
  });

  it("never re-resolves for anonymous visitors or without resolveOnOpen", async () => {
    const { unmount } = renderWithProviders(
      <PaperDetailsPanel paperKey="10.1/PANEL" onClose={() => {}} resolveOnOpen />,
    );
    await screen.findByText("Panel Paper");
    unmount();

    testAuth.authenticated = true;
    renderWithProviders(<PaperDetailsPanel paperKey="10.1/PANEL" onClose={() => {}} />);
    await screen.findByText("Panel Paper");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(library.resolve).not.toHaveBeenCalled();
  });
});
