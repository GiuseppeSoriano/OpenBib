import { testAuth, mockRefresh } from "@/test/auth-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import SearchResultCard from "@/components/search/SearchResultCard";
import { renderWithProviders } from "@/test/utils";
import type { PaperMetadata } from "@/types";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn((url: string) => {
      if (url === "/users/me") return Promise.resolve({ data: { id: "u1", email: "ada@example.com", display_name: "Ada" } });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    put: vi.fn(),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
  papers: {},
  library: { ensureEntry: vi.fn(() => Promise.resolve()), listKeys: vi.fn(() => Promise.resolve([])) },
  notes: {},
  graph: {},
  zotero: {},
}));

const paper: PaperMetadata = {
  canonical_key: "s2:abc",
  paper_group_key: "s2:abc",
  title: "Attention Is All You Need",
  authors: [{ name: "Ashish Vaswani", openalex_id: null, orcid: null, affiliations: [] }],
  abstract: "The dominant sequence transduction models…",
  publication_date: "2017-06-12",
  doi: null,
  arxiv_id: null,
  venue: "NeurIPS",
  paper_type: null,
  topics: [],
  keywords: [],
  open_access: true,
  pdf_url: null,
  cited_by_count: 100,
  reference_count: 10,
  provider_source: "semantic_scholar",
  provider_sources: ["semantic_scholar"],
};

function renderCard(props: { inLibrary?: boolean; isDismissed?: boolean; compact?: boolean } = {}) {
  testAuth.authenticated = true;
  return renderWithProviders(
    <SearchResultCard
      paper={paper}
      providerSources={[]}
      savedInCollections={[]}
      isDismissed={props.isDismissed ?? false}
      inLibrary={props.inLibrary ?? false}
      onOpenDetails={() => {}}
      compact={props.compact}
    />,
  );
}

/** The decorative icon leading a row action, hidden from assistive tech. */
function leadingIcon(element: HTMLElement) {
  const icon = element.firstElementChild;
  expect(icon?.tagName.toLowerCase()).toBe("svg");
  expect(icon).toHaveAttribute("aria-hidden", "true");
  return icon as SVGElement;
}

afterEach(() => {
  testAuth.authenticated = false;
});

describe("SearchResultCard actions", () => {
  it("leads every quiet action with a hidden icon and keeps the accessible names", async () => {
    renderCard();
    const save = await screen.findByRole("button", { name: "Save" });
    const names = ["Add to collection", "Cite", "Not relevant"];
    for (const element of [save, ...names.map((name) => screen.getByRole("button", { name }))]) {
      expect(leadingIcon(element).getAttribute("width")).toBe("14");
    }
    const graph = screen.getByRole("link", { name: "Citation graph" });
    expect(graph).toHaveAttribute("href", "/graph/s2%3Aabc");
    // The sidebar's Citation graph item uses the same Share2 icon.
    expect(leadingIcon(graph).getAttribute("class")).toMatch(/lucide-share-?2/);
  });

  it("keeps an icon on In Library and Undo dismiss", async () => {
    renderCard({ inLibrary: true, isDismissed: true });
    leadingIcon(await screen.findByRole("button", { name: "In Library" }));
    leadingIcon(screen.getByRole("button", { name: "Undo dismiss" }));
  });

  it("shows the same icons in the compact More menu", async () => {
    renderCard({ compact: true });
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    leadingIcon(screen.getByRole("menuitem", { name: "Cite" }));
    expect(leadingIcon(screen.getByRole("menuitem", { name: "Citation graph" })).getAttribute("class")).toMatch(
      /lucide-share-?2/,
    );
    leadingIcon(screen.getByRole("menuitem", { name: "Not relevant" }));
  });
});
