import { mockRefresh } from "@/test/auth-mock";
import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import SearchPage from "@/pages/SearchPage";
import { renderWithProviders } from "@/test/utils";
import type { PaperMetadata } from "@/types";

function paper(key: string, title: string, overrides: Partial<PaperMetadata> = {}): PaperMetadata {
  return {
    canonical_key: key,
    paper_group_key: `group:${key}`,
    title,
    authors: [{ name: "Alice Smith", openalex_id: null, orcid: null, affiliations: [] }],
    abstract: null,
    publication_date: "2024-01-01",
    doi: null,
    arxiv_id: null,
    pmid: null,
    pmcid: null,
    openalex_id: null,
    venue: "VLDB",
    volume: null,
    issue: null,
    pages: null,
    paper_type: null,
    topics: [],
    keywords: [],
    open_access: null,
    pdf_url: null,
    abstract_url: null,
    cited_by_count: 5,
    reference_count: null,
    version: null,
    provider_source: "openalex",
    provider_sources: ["openalex"],
    ...overrides,
  };
}

const groupV1 = paper("hash:v1", "Grouped Paper", {
  paper_group_key: "group:g",
  version: "v1",
  provider_source: "arxiv",
});
const groupV2 = paper("hash:v2", "Grouped Paper", {
  paper_group_key: "group:g",
  publication_date: "2025-02-01",
  provider_source: "crossref",
});

const searchResponse = {
  items: [
    { kind: "paper", paper: paper("doi:10.1/solo", "Solo Paper") },
    {
      kind: "paper_group",
      paper_group_key: "group:g",
      title: "Grouped Paper",
      authors: [],
      version_count: 2,
      selected_version: groupV2,
      versions: [groupV2, groupV1],
      provider_sources: ["arxiv", "crossref"],
    },
  ],
  total_count: 2,
  raw_total_count: 3,
  page: 1,
  page_size: 20,
  providers: ["openalex", "crossref"],
};

// Tests that need a different payload swap this and restore it afterwards.
const responseState = { current: searchResponse };

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn((url: string) => {
      if (url === "/papers/search") return Promise.resolve({ data: responseState.current });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  papers: { getDetail: vi.fn() },
  library: { listKeys: vi.fn(() => Promise.resolve([])) },
  notes: {},
  graph: {},
  zotero: {},
}));

describe("SearchPage", () => {
  it("runs the query from the URL and renders results", async () => {
    renderWithProviders(<SearchPage />, { route: "/search?q=databases" });

    expect(await screen.findByText("Solo Paper")).toBeInTheDocument();
    expect(screen.getByText("Grouped Paper")).toBeInTheDocument();
    expect(screen.getByText(/2 grouped results from/)).toBeInTheDocument();
  });

  it("shows a humanized version picker for grouped results", async () => {
    renderWithProviders(<SearchPage />, { route: "/search?q=databases" });
    await screen.findByText("Grouped Paper");

    const picker = screen.getByTestId("version-picker");
    expect(picker).toHaveTextContent("Published 2025 · Crossref");
    expect(picker).toHaveTextContent("Preprint v1 · arXiv");
  });

  it("hides user-scoped filter pills for anonymous visitors", async () => {
    renderWithProviders(<SearchPage />, { route: "/search?q=databases" });
    await screen.findByText("Solo Paper");

    expect(screen.queryByText("Unsaved only")).toBeNull();
    expect(screen.queryByText("Hide dismissed")).toBeNull();
    // Anonymous cards expose exploration only — no save/dismiss actions.
    expect(screen.queryByText("Save to Library")).toBeNull();
  });
});

describe("SearchPage — version picker", () => {
  afterEach(() => {
    responseState.current = searchResponse;
  });

  it("exposes versions as radios with unique names and a checked selection", async () => {
    const preprint = { paper_group_key: "group:p", provider_source: "crossref", paper_type: "posted-content" };
    const first = paper("doi:10.20944/p.v1", "Same Year", { ...preprint, publication_date: "2021-01-04" });
    const second = paper("doi:10.20944/p.v2", "Same Year", { ...preprint, publication_date: "2021-03-09" });
    responseState.current = {
      ...searchResponse,
      items: [
        {
          kind: "paper_group",
          paper_group_key: "group:p",
          title: "Same Year",
          authors: [],
          version_count: 2,
          selected_version: second,
          versions: [second, first],
          provider_sources: ["crossref"],
        },
      ],
    } as typeof searchResponse;
    renderWithProviders(<SearchPage />, { route: "/search?q=same" });
    await screen.findByText("Same Year");

    const group = screen.getByRole("radiogroup", { name: "Versions of this paper" });
    const radios = within(group).getAllByRole("radio");
    const names = radios.map((radio) => radio.getAttribute("aria-label") ?? "");
    expect(new Set(names).size).toBe(2);
    expect(names.join(" ")).not.toMatch(/10\.20944|doi:/);
    expect(radios[0]).toHaveTextContent("Preprint 2021 · Crossref · Posted Mar 9, 2021");
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[1]).toHaveAttribute("aria-checked", "false");

    fireEvent.click(radios[1]!);
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    expect(radios[0]).toHaveAttribute("aria-checked", "false");

    fireEvent.keyDown(radios[1]!, { key: "ArrowRight" });
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[0]).toHaveFocus();
  });
});

it("appends pages, deduplicates overlapping papers, and resets for a new query", async () => {
  const api = (await import("@/lib/api")).default;
  const { fireEvent } = await import("@testing-library/react");
  vi.mocked(api.get).mockImplementation(async (url, config) => {
    if (url !== "/papers/search") return { data: [] };
    const page = config?.params?.page ?? 1;
    if (config?.params?.q === "different") return { data: { ...searchResponse, has_more: false, items: [{ kind: "paper", paper: paper("new", "New query paper") }] } };
    return { data: { ...searchResponse, page, has_more: page === 1, items: page === 1 ? searchResponse.items : [searchResponse.items[0], { kind: "paper", paper: paper("later", "Later paper") }] } };
  });
  renderWithProviders(<SearchPage />, { route: "/search?q=databases" });
  fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
  expect(await screen.findByText("Later paper")).toBeInTheDocument();
  expect(screen.getAllByText("Solo Paper")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "different" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("New query paper")).toBeInTheDocument();
  expect(screen.queryByText("Later paper")).toBeNull();
});

it("preserves earlier results and retries a failed next page", async () => {
  const api = (await import("@/lib/api")).default;
  const { fireEvent } = await import("@testing-library/react");
  let fail = true;
  vi.mocked(api.get).mockImplementation(async (_url, config) => {
    const page = config?.params?.page ?? 1;
    if (page === 2 && fail) throw new Error("offline");
    return { data: { ...searchResponse, page, has_more: page === 1, items: page === 1 ? searchResponse.items : [{ kind: "paper", paper: paper("last", "Final paper") }] } };
  });
  renderWithProviders(<SearchPage />, { route: "/search?q=databases" });
  fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByText("Solo Paper")).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Final paper")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("merges versions split across pages without using title similarity", async () => {
  const { mergeSearchPages } = await import("@/lib/search-pages");
  const version = paper("hash:v3", "Grouped Paper", { paper_group_key: "group:g" });
  const first = { ...searchResponse, has_more: true } as import("@/types").SearchResult;
  const second: import("@/types").SearchResult = { ...first, page: 2, has_more: false, items: [
    { kind: "paper", paper: groupV1 }, { kind: "paper", paper: version },
    { kind: "paper", paper: paper("different", "Grouped Paper") },
  ] };
  const items = mergeSearchPages([first, second]);
  expect(items).toHaveLength(3);
  const group = items[1]!;
  expect(group.kind).toBe("paper_group");
  if (group.kind === "paper_group") {
    expect(group.versions).toHaveLength(3);
    expect(group.selected_version.canonical_key).toBe(groupV2.canonical_key);
  }
});
