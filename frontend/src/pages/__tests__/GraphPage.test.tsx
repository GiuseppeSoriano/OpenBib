import { focusManager } from "@tanstack/react-query";
import { mockRefresh } from "@/test/auth-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Link, Routes, Route } from "react-router-dom";
import GraphPage from "@/pages/GraphPage";
import { mockMatchMedia, renderWithProviders, restoreMatchMedia } from "@/test/utils";
import type { GraphNode, GraphResponse, PaperMetadata, RelatedRangeRequest, RelatedRangeResponse } from "@/types";

// The canvas engine cannot run in jsdom — replace it with a stub that
// records its props (click, drag) and counts mounts.
const engine = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: {} as Record<string, any>,
  mounts: 0,
}));

vi.mock("react-force-graph-2d", async () => {
  const { forwardRef, useEffect } = await import("react");
  return {
    default: forwardRef(function GraphStub(props: Record<string, unknown>) {
      engine.props = props;
      useEffect(() => {
        engine.mounts += 1;
      }, []);
      return <div data-testid="force-graph-stub" />;
    }),
  };
});

const api = vi.hoisted(() => ({
  buildPaper: vi.fn(),
  buildCollection: vi.fn(),
  related: vi.fn(),
  topUp: vi.fn(),
}));

const http = vi.hoisted(() => ({
  get: vi.fn<(url: string, config?: unknown) => Promise<{ data: unknown }>>(() => Promise.resolve({ data: [] })),
}));

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: { get: http.get, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  graph: api,
  papers: { getDetail: vi.fn() },
  library: { listKeys: vi.fn(() => Promise.resolve([])) },
  notes: {},
  zotero: {},
}));

function paper(key: string, group: string, title: string, overrides: Partial<PaperMetadata> = {}): PaperMetadata {
  return {
    canonical_key: key,
    paper_group_key: group,
    title,
    authors: [{ name: "Alice Smith", openalex_id: null, orcid: null, affiliations: [] }],
    abstract: null,
    publication_date: "2020-01-01",
    doi: null,
    arxiv_id: null,
    pmid: null,
    pmcid: null,
    openalex_id: null,
    venue: "NeurIPS",
    volume: null,
    issue: null,
    pages: null,
    paper_type: null,
    topics: [],
    keywords: [],
    open_access: null,
    pdf_url: null,
    abstract_url: null,
    cited_by_count: 10,
    reference_count: null,
    version: null,
    provider_source: "openalex",
    provider_sources: ["openalex"],
    ...overrides,
  };
}

function node(version: PaperMetadata, isSeed = false): GraphNode {
  return {
    id: version.paper_group_key,
    label: version.title,
    type: "paper",
    paper_group_key: version.paper_group_key,
    version_count: 1,
    selected_version: version,
    versions: [version],
    is_seed: isSeed,
  };
}

const seedPaper = paper("hash:seed", "group:seed", "Seed Paper");
const otherPaper = paper("doi:10.1/other", "group:other", "Other Paper");

function baseGraph(seed: PaperMetadata = seedPaper): GraphResponse {
  return {
    active_paper_key: seed.canonical_key,
    active_paper_group_key: seed.paper_group_key,
    nodes: [node(seed, true), node(otherPaper)],
    edges: [],
    related_range_size: 30,
    related_max_results: 10000,
  };
}

interface RangeOptions {
  total?: number;
  exact?: boolean;
  prefix?: string;
}

/** A served range of `total` related papers named "<prefix> <rank>". */
function rangeResponse(body: RelatedRangeRequest, { total = 1000, exact = true, prefix = "Related" }: RangeOptions = {}): RelatedRangeResponse {
  const start = body.last ? Math.max(0, Math.floor((total - 1) / 30) * 30) : body.range_start;
  const end = Math.min(start + 30, total);
  const nodes = Array.from({ length: Math.max(0, end - start) }, (_, i) =>
    node(paper(`hash:${prefix}-${start + i}`, `group:${prefix}-${start + i}`, `${prefix} ${start + i + 1}`)),
  );
  return {
    source_key: body.source_key,
    source_group_key: body.source_group_key,
    direction: body.direction,
    order: body.order,
    nodes,
    edges: nodes.map((item) => ({ source: item.id, target: body.source_group_key, relation_type: "cited_by" })),
    group_keys: nodes.map((item) => item.id),
    range_start: start,
    range_end: end,
    range_size: 30,
    max_results: 10000,
    total_available: total,
    total_exact: exact,
    total_capped: false,
    provider_total: total,
    scanned: end,
    has_more: end < total,
    exhausted: end >= total,
    clamped: false,
    scan_incomplete: false,
    snapshot_id: null,
    reason: null,
  };
}

function httpError(status: number, headers: Record<string, string> = {}, data: unknown = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data, headers } });
}

function codedError(status: number, code: string, headers: Record<string, string> = {}) {
  return httpError(status, headers, { detail: { code, message: "server text" } });
}

/** The related list is still being collected and ranked: no nodes yet. */
function rankingResponse(body: RelatedRangeRequest, scanned: number): RelatedRangeResponse {
  return {
    ...rangeResponse(body),
    nodes: [],
    edges: [],
    group_keys: [],
    range_end: body.range_start,
    total_available: 0,
    total_exact: false,
    provider_total: 9898,
    scanned,
    scan_incomplete: true,
    reason: "ranking",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderGraph(route = "/graph/hash:seed") {
  return renderWithProviders(
    <Routes>
      <Route path="/graph/:paperKey" element={<GraphPage mode="paper" />} />
      <Route path="/graph" element={<GraphPage mode="manual" />} />
    </Routes>,
    { route },
  );
}

async function ready() {
  await screen.findByTestId("force-graph-stub");
}

function bar() {
  return screen.getByTestId("graph-bottombar");
}

function openPapers() {
  fireEvent.click(screen.getByRole("button", { name: /^Papers \(/ }));
  return screen.getByRole("complementary", { name: "Papers on the graph" });
}

/** Select the seed through the paper list (the canvas' accessible twin). */
function selectSeed() {
  const list = openPapers();
  fireEvent.click(within(list).getByRole("button", { name: /^Seed Paper/ }));
  return list;
}

function ranges() {
  return screen.getByRole("navigation", { name: "Result ranges" });
}

async function loadFirstRange() {
  fireEvent.click(within(ranges()).getByRole("button", { name: /^1–30 — not loaded yet/ }));
  return within(ranges()).findByRole("button", { name: "Show results 1 to 30" });
}

function forceNode(id: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return engine.props.graphData.nodes.find((item: any) => item.id === id);
}

describe("GraphPage (desktop)", () => {
  beforeEach(() => {
    mockMatchMedia(() => false);
    engine.mounts = 0;
    api.buildPaper.mockReset().mockImplementation(() => Promise.resolve(baseGraph()));
    api.related.mockReset().mockImplementation((body: RelatedRangeRequest) => Promise.resolve(rangeResponse(body)));
    api.topUp.mockReset();
  });

  afterEach(() => {
    restoreMatchMedia();
  });

  it("renders the header h1 and the always-visible bar with Direction and Order", async () => {
    renderGraph();
    await ready();

    expect(screen.getByRole("heading", { level: 1, name: /^Citation graph ?: Seed Paper$/ })).toBeInTheDocument();
    expect(screen.getByText("Paper")).toBeInTheDocument();
    expect(screen.getByText("2 papers · 0 links")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Citation graph of “Seed Paper” with 2 papers and 0 links/ })).toBeInTheDocument();

    const direction = within(bar()).getByRole("group", { name: "Direction" });
    expect(within(direction).getByRole("button", { name: "Citers" })).toHaveAttribute("aria-pressed", "true");
    expect(within(direction).getByRole("button", { name: "References" })).toHaveAttribute("aria-pressed", "false");
    const order = within(bar()).getByRole("group", { name: "Order" });
    expect(within(order).getByRole("button", { name: "Top cited" })).toHaveAttribute("aria-pressed", "true");
    expect(within(order).getByRole("button", { name: "Most recent" })).toHaveAttribute("aria-pressed", "false");

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(/Expand entire graph/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Graph controls" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("enables Expand pinned nodes for the auto-pinned seed and shows no ranges without a selection", async () => {
    renderGraph();
    await ready();

    expect(within(bar()).getByRole("button", { name: "Expand pinned nodes" })).toBeEnabled();
    expect(within(bar()).getByText("Adds up to 30 related papers to each pinned paper.")).toBeInTheDocument();
    expect(within(bar()).getByText("Select a paper to browse its citers or references.")).toBeInTheDocument();
    expect(within(bar()).getByText("1 pinned")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Result ranges" })).toBeNull();
  });

  it("selects through the paper list and toggles Pin with a constant name and no request", async () => {
    renderGraph();
    await ready();
    const list = selectSeed();

    expect(within(list).getByRole("button", { name: /^Seed Paper/ })).toHaveAttribute("aria-current", "true");
    const popup = screen.getByTestId("graph-node-popup");
    expect(within(popup).getByRole("heading", { level: 2, name: "Seed Paper" })).toBeInTheDocument();
    expect(within(bar()).getByText("Citers of “Seed Paper”")).toBeInTheDocument();

    const pin = within(popup).getByRole("button", { name: "Pin “Seed Paper”" });
    expect(pin).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(pin);
    expect(within(popup).getByRole("button", { name: "Pin “Seed Paper”" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(list).getByRole("button", { name: "Pin “Other Paper”" }));
    expect(within(list).getByRole("button", { name: "Pin “Other Paper”" })).toHaveAttribute("aria-pressed", "true");

    expect(api.related).not.toHaveBeenCalled();
    expect(api.topUp).not.toHaveBeenCalled();
    const legend = screen.getByText("Legend").closest("details")!;
    expect(within(legend).getByText("Pinned")).toBeInTheDocument();
    expect(within(legend).getByText("Selected")).toBeInTheDocument();
  });

  it("loads 1–30 on the first tap with the pinned exclusions", async () => {
    renderGraph();
    await ready();
    const list = openPapers();
    fireEvent.click(within(list).getByRole("button", { name: "Pin “Other Paper”" }));
    fireEvent.click(within(list).getByRole("button", { name: /^Seed Paper/ }));

    const first = within(ranges()).getByRole("button", { name: "1–30 — not loaded yet, tap to load" });
    expect(first).toHaveAttribute("aria-current", "true");
    expect(api.related).not.toHaveBeenCalled();

    fireEvent.click(first);
    expect(api.related).toHaveBeenCalledTimes(1);
    expect(api.related.mock.calls[0]![0]).toEqual({
      source_key: "hash:seed",
      source_group_key: "group:seed",
      direction: "cited_by",
      order: "cited_by_count",
      range_start: 0,
      last: false,
      exclude_group_keys: ["group:other"],
    });
    expect(await within(ranges()).findByRole("button", { name: "Show results 1 to 30" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("1–30 of 1,000")).toBeInTheDocument();
    expect(screen.getByText(/Totals count what Semantic Scholar can list/)).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Papers on the graph" })).getByText("Related 1")).toBeInTheDocument();
  });

  it("shows five range buttons for 1,000 results and requests aligned starts", async () => {
    renderGraph();
    await ready();
    selectSeed();
    await loadFirstRange();

    fireEvent.click(within(ranges()).getByRole("button", { name: "Show results 31 to 60" }));
    expect(api.related).toHaveBeenLastCalledWith(expect.objectContaining({ range_start: 30, last: false }), expect.anything());
    expect(await within(ranges()).findByRole("button", { name: "Show results 31 to 60" })).toHaveAttribute("aria-current", "true");

    fireEvent.click(within(ranges()).getByRole("button", { name: "Show results 61 to 90" }));
    expect(api.related).toHaveBeenLastCalledWith(expect.objectContaining({ range_start: 60 }), expect.anything());
    expect(await within(ranges()).findByRole("button", { name: "Show results 61 to 90" })).toHaveAttribute("aria-current", "true");
    expect(within(ranges()).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "1–30",
      "31–60",
      "61–90",
      "91–120",
      "991–1,000",
    ]);
    expect(ranges().querySelector('[aria-hidden="true"]')?.textContent).toBe("…");
  });

  it("offers Last with last:true when the total is an estimate", async () => {
    api.related.mockImplementation((body: RelatedRangeRequest) => Promise.resolve(rangeResponse(body, { total: 95, exact: false })));
    renderGraph();
    await ready();
    selectSeed();
    await loadFirstRange();
    expect(screen.getByText("1–30 of about 95")).toBeInTheDocument();

    fireEvent.click(within(ranges()).getByRole("button", { name: "Show the last results (total not yet known)" }));
    expect(api.related).toHaveBeenLastCalledWith(expect.objectContaining({ last: true }), expect.anything());
  });

  it("labels capped totals with locale number formatting", async () => {
    api.related.mockImplementation((body: RelatedRangeRequest) =>
      Promise.resolve({ ...rangeResponse(body, { total: 10000 }), total_capped: true, provider_total: 50000 }),
    );
    renderGraph();
    await ready();
    selectSeed();
    await loadFirstRange();
    expect(
      screen.getByText("1–30 · top of the first 10,000 returned by Semantic Scholar (about 50,000 in all)"),
    ).toBeInTheDocument();

    const { default: i18n } = await import("@/i18n");
    await act(async () => {
      await i18n.changeLanguage("it");
    });
    expect(
      screen.getByText("1–30 · migliori tra i primi 10.000 restituiti da Semantic Scholar (circa 50.000 in tutto)"),
    ).toBeInTheDocument();
  });

  it("ignores a late response after an order switch and reloads 1–30 without rebuilding the graph", async () => {
    renderGraph();
    await ready();
    const list = selectSeed();
    await loadFirstRange();

    const late = deferred<RelatedRangeResponse>();
    api.related.mockImplementationOnce(() => late.promise);
    fireEvent.click(within(ranges()).getByRole("button", { name: "Show results 31 to 60" }));
    expect(within(bar()).getByText("Loading 31–60…")).toBeInTheDocument();
    const lateBody = api.related.mock.calls[1]![0] as RelatedRangeRequest;

    const fresh = deferred<RelatedRangeResponse>();
    api.related.mockImplementationOnce(() => fresh.promise);
    fireEvent.click(within(bar()).getByRole("button", { name: "Most recent" }));
    expect(api.related).toHaveBeenCalledTimes(3);
    const freshBody = api.related.mock.calls[2]![0] as RelatedRangeRequest;
    expect(freshBody).toMatchObject({ order: "recent", range_start: 0, last: false, source_group_key: "group:seed" });

    await act(async () => late.resolve(rangeResponse(lateBody, { prefix: "Late" })));
    expect(within(list).queryByText("Late 31")).toBeNull();

    await act(async () => fresh.resolve(rangeResponse(freshBody, { prefix: "Recent" })));
    expect(await within(ranges()).findByRole("button", { name: "Show results 1 to 30" })).toHaveAttribute("aria-current", "true");
    expect(within(list).getByText("Recent 1")).toBeInTheDocument();
    expect(within(list).queryByText("Related 1")).toBeNull();
    expect(within(list).queryByText("Late 31")).toBeNull();
    expect(api.buildPaper).toHaveBeenCalledTimes(1);
  });

  it("shows the provider error with a Retry that re-issues the request", async () => {
    api.related.mockImplementationOnce(() => Promise.reject(httpError(502)));
    renderGraph();
    await ready();
    selectSeed();
    fireEvent.click(within(ranges()).getByRole("button", { name: /^1–30 — not loaded yet/ }));

    expect(await within(bar()).findByText("The citation provider is unavailable right now.")).toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole("button", { name: "Try again" }));
    expect(api.related).toHaveBeenCalledTimes(2);
    expect(await within(ranges()).findByRole("button", { name: "Show results 1 to 30" })).toBeInTheDocument();
  });

  it("counts down after a 429 before Retry is available", async () => {
    api.related.mockImplementationOnce(() => Promise.reject(httpError(429, { "retry-after": "30" })));
    renderGraph();
    await ready();
    selectSeed();
    fireEvent.click(within(ranges()).getByRole("button", { name: /^1–30 — not loaded yet/ }));

    expect(await within(bar()).findByText("Too many requests. Try again in 30 s.")).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: "Try again" })).toBeDisabled();
  });

  it("shows coded related-paper errors, with a countdown when the provider is rate limited", async () => {
    api.related
      .mockImplementationOnce(() => Promise.reject(codedError(503, "related_provider_unavailable")))
      .mockImplementationOnce(() => Promise.reject(codedError(503, "provider_rate_limited", { "retry-after": "20" })));
    renderGraph();
    await ready();
    selectSeed();
    fireEvent.click(within(ranges()).getByRole("button", { name: /^1–30 — not loaded yet/ }));

    expect(
      await within(bar()).findByText("Citation data from Semantic Scholar is unavailable right now. Please try again later."),
    ).toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole("button", { name: "Try again" }));

    expect(
      await within(bar()).findByText("Semantic Scholar is receiving too many requests. Try again in 20 s."),
    ).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: "Try again" })).toBeDisabled();
    expect(screen.queryByText(/server text/)).toBeNull();
  });

  it("tells a missing Semantic Scholar key apart from an outage", async () => {
    const detail = { code: "related_provider_unavailable", message: "server text", reason: "not_configured" };
    api.related.mockImplementationOnce(() => Promise.reject(httpError(503, {}, { detail })));
    renderGraph();
    await ready();
    selectSeed();
    fireEvent.click(within(ranges()).getByRole("button", { name: /^1–30 — not loaded yet/ }));

    expect(await within(bar()).findByText(/set SEMANTIC_SCHOLAR_API_KEY\.$/)).toBeInTheDocument();
    expect(within(bar()).queryByText(/try again later/i)).toBeNull();
  });

  it("keeps asking while the provider list is ranked, then offers Continue", async () => {
    const held = deferred<void>();
    let calls = 0;
    api.related.mockImplementation((body: RelatedRangeRequest) => {
      calls += 1;
      const response = rankingResponse(body, calls * 1000);
      return calls === 2 ? held.promise.then(() => response) : Promise.resolve(response);
    });
    renderGraph();
    await ready();
    selectSeed();
    fireEvent.click(within(ranges()).getByRole("button", { name: /^1–30 — not loaded yet/ }));

    expect(await within(bar()).findByText("Ranking 1,000 of about 9,898 related papers…")).toBeInTheDocument();
    await act(async () => held.resolve());
    // The first answer plus six automatic re-requests, then the user decides.
    expect(
      await within(bar()).findByText("Still ranking: 7,000 of about 9,898 related papers collected so far."),
    ).toBeInTheDocument();
    expect(api.related).toHaveBeenCalledTimes(7);
    expect(within(ranges()).getByRole("button", { name: /^1–30 — not loaded yet/ })).toBeInTheDocument();

    api.related.mockImplementation((body: RelatedRangeRequest) => Promise.resolve(rangeResponse(body)));
    fireEvent.click(within(bar()).getByRole("button", { name: "Continue" }));
    expect(api.related).toHaveBeenCalledTimes(8);
    expect(api.related.mock.calls[7]![0]).toEqual(api.related.mock.calls[0]![0]);
    expect(await within(ranges()).findByRole("button", { name: "Show results 1 to 30" })).toHaveAttribute("aria-current", "true");
    expect(within(bar()).queryByText(/Still ranking/)).toBeNull();
  });

  it("notes a base graph whose links are incomplete until dismissed", async () => {
    api.buildPaper.mockImplementation(() => Promise.resolve({ ...baseGraph(), edges_partial: true }));
    renderGraph();
    await ready();

    const notice = "Some links between these papers couldn’t be loaded in time, so a few may be missing.";
    expect(within(bar()).getByText(notice)).toBeInTheDocument();
    selectSeed();
    await loadFirstRange();
    expect(within(bar()).getByText(notice)).toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole("button", { name: "Dismiss notification" }));
    expect(within(bar()).queryByText(notice)).toBeNull();
  });

  it("disables Expand pinned nodes with a hint when nothing is pinned", async () => {
    renderGraph();
    await ready();
    const list = openPapers();
    fireEvent.click(within(list).getByRole("button", { name: "Pin “Seed Paper”" }));

    expect(within(bar()).getByRole("button", { name: "Expand pinned nodes" })).toBeDisabled();
    expect(within(bar()).getByText("Pin a paper to expand it.")).toBeInTheDocument();
  });

  it("tops up the pinned papers from Expand pinned nodes", async () => {
    api.topUp.mockResolvedValue({ nodes: [], edges: [], sources: [], range_size: 30, max_results: 10000 });
    renderGraph();
    await ready();
    fireEvent.click(within(bar()).getByRole("button", { name: "Expand pinned nodes" }));

    await waitFor(() => expect(api.topUp).toHaveBeenCalledTimes(1));
    expect(api.topUp.mock.calls[0]![0]).toMatchObject({
      direction: "cited_by",
      order: "cited_by_count",
      target_per_source: 30,
      sources: [{ source_key: "hash:seed", source_group_key: "group:seed", connected_group_keys: [] }],
    });
    expect(api.related).not.toHaveBeenCalled();
  });

  it("pauses Expand pinned nodes while the provider is rate limited for a source", async () => {
    api.topUp.mockResolvedValue({
      nodes: [],
      edges: [],
      sources: [
        {
          source_key: "hash:seed",
          source_group_key: "group:seed",
          added_group_keys: [],
          connected_count: 0,
          total_available: 0,
          total_exact: false,
          total_capped: false,
          provider_total: null,
          exhausted: false,
          reason: null,
          error: "rate_limited",
        },
      ],
      range_size: 30,
      max_results: 10000,
    });
    renderGraph();
    await ready();
    fireEvent.click(within(bar()).getByRole("button", { name: "Expand pinned nodes" }));

    expect(await within(bar()).findByText("Paused: too many requests. Resuming in 30 s.")).toBeInTheDocument();
    expect(within(bar()).getByText("Expanding 0 of 1 pinned papers…")).toBeInTheDocument();
    expect(api.topUp).toHaveBeenCalledTimes(1);
  });

  it("pins a dragged node without any request", async () => {
    renderGraph();
    await ready();
    act(() => engine.props.onNodeDragEnd(forceNode("group:other")));

    expect(within(bar()).getByText("2 pinned")).toBeInTheDocument();
    expect(api.related).not.toHaveBeenCalled();
    expect(api.topUp).not.toHaveBeenCalled();
  });

  it("selects and loads 1–30 on a node double-click", async () => {
    renderGraph();
    await ready();
    const seed = forceNode("group:seed");
    act(() => {
      engine.props.onNodeClick(seed);
      engine.props.onNodeClick(seed);
    });

    expect(api.related).toHaveBeenCalledTimes(1);
    expect(api.related).toHaveBeenLastCalledWith(
      expect.objectContaining({ source_group_key: "group:seed", range_start: 0, last: false }),
      expect.anything(),
    );
    expect(await within(ranges()).findByRole("button", { name: "Show results 1 to 30" })).toHaveAttribute("aria-current", "true");
  });

  it.each([
    [422, {}, "Graphs are limited to 200 papers. Open a smaller collection or a single paper."],
    [429, { "retry-after": "12" }, "Too many requests. Try again in 12 s."],
    [404, {}, "This graph isn’t available."],
  ])("shows a specific base error for HTTP %i with Retry", async (status, headers, message) => {
    api.buildPaper.mockImplementation(() => Promise.reject(httpError(status, headers)));
    renderGraph();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(message)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Citation graph" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(api.buildPaper).toHaveBeenCalledTimes(1);

    fireEvent.click(within(alert).getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(api.buildPaper).toHaveBeenCalledTimes(2));
  });

  it("retries a 5xx base failure once before showing the error", async () => {
    api.buildPaper.mockImplementation(() => Promise.reject(httpError(500)));
    renderGraph();

    const alert = await screen.findByRole("alert", {}, { timeout: 4000 });
    expect(within(alert).getByText("Couldn’t load this graph.")).toBeInTheDocument();
    expect(api.buildPaper).toHaveBeenCalledTimes(2);
  });

  it("shows Details unavailable for an unresolved seed, never its key", async () => {
    const unresolved = paper("hash:abc123", "hash:abc123", "hash:abc123", {
      provider_source: "unknown",
      provider_sources: [],
      authors: [],
      venue: null,
      cited_by_count: null,
    });
    api.buildPaper.mockImplementation(() => Promise.resolve(baseGraph(unresolved)));
    renderGraph("/graph/hash:abc123");
    await ready();

    expect(screen.getByRole("heading", { level: 1, name: "Citation graph" })).toBeInTheDocument();
    const list = openPapers();
    fireEvent.click(within(list).getByRole("button", { name: /^Details unavailable/ }));
    const popup = screen.getByTestId("graph-node-popup");
    expect(within(popup).getByRole("heading", { level: 2, name: "Details unavailable" })).toBeInTheDocument();
    expect(screen.queryByText(/abc123/)).toBeNull();
  });

  it("resets pins when the page is mounted again (pins are session-only)", async () => {
    const view = renderGraph();
    await ready();
    fireEvent.click(within(openPapers()).getByRole("button", { name: "Pin “Other Paper”" }));
    expect(within(bar()).getByText("2 pinned")).toBeInTheDocument();
    view.unmount();

    renderGraph();
    await ready();
    expect(within(bar()).getByText("1 pinned")).toBeInTheDocument();
  });

  it("keeps the canvas mount, selection, mode and ranges across desktop and compact", async () => {
    const media = mockMatchMedia(() => false);
    renderGraph();
    await ready();
    selectSeed();
    fireEvent.click(within(bar()).getByRole("button", { name: "Most recent" }));
    expect(api.related).not.toHaveBeenCalled();
    await loadFirstRange();
    expect(api.related).toHaveBeenLastCalledWith(expect.objectContaining({ order: "recent" }), expect.anything());
    expect(engine.mounts).toBe(1);

    act(() => media.set(() => true));
    expect(screen.queryByTestId("graph-bottombar")).toBeNull();
    const summary = screen.getByTestId("graph-summary");
    expect(within(summary).getByRole("button", { name: "Seed Paper" })).toBeInTheDocument();
    expect(within(summary).getByRole("button", { name: "Show results 1 to 30" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Graph controls" }));
    const dialog = screen.getByRole("dialog", { name: "Graph controls" });
    expect(within(dialog).getByRole("button", { name: "Most recent" })).toHaveAttribute("aria-pressed", "true");

    // Growing past compact with the sheet open drops it for good.
    act(() => media.set(() => false));
    expect(screen.queryByRole("dialog", { name: "Graph controls" })).toBeNull();
    expect(within(bar()).getByText("Citers of “Seed Paper”")).toBeInTheDocument();
    expect(within(bar()).getByText("1 pinned")).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: "Most recent" })).toHaveAttribute("aria-pressed", "true");
    expect(within(ranges()).getByRole("button", { name: "Show results 1 to 30" })).toHaveAttribute("aria-current", "true");
    expect(api.related).toHaveBeenCalledTimes(1);

    act(() => media.set(() => true));
    expect(screen.queryByRole("dialog", { name: "Graph controls" })).toBeNull();
    expect(screen.getByRole("button", { name: "Graph controls" })).toHaveAttribute("aria-expanded", "false");
    expect(engine.mounts).toBe(1);
  });
});

describe("GraphPage (compact)", () => {
  beforeEach(() => {
    mockMatchMedia(() => true);
    engine.mounts = 0;
    api.buildPaper.mockReset().mockImplementation(() => Promise.resolve(baseGraph()));
    api.related.mockReset().mockImplementation((body: RelatedRangeRequest) => Promise.resolve(rangeResponse(body)));
    api.topUp.mockReset();
  });

  afterEach(() => {
    restoreMatchMedia();
  });

  function trigger() {
    return screen.getByRole("button", { name: "Graph controls" });
  }

  function openSheet() {
    fireEvent.click(trigger());
    return screen.getByRole("dialog", { name: "Graph controls" });
  }

  function summary() {
    return screen.getByTestId("graph-summary");
  }

  function selectSeedOnCanvas() {
    act(() => engine.props.onNodeClick(forceNode("group:seed")));
  }

  it("shows Fit and the controls trigger but no toggles or panels until the sheet opens", async () => {
    renderGraph();
    await ready();

    expect(screen.getByRole("heading", { level: 1, name: /^Citation graph ?: Seed Paper$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit to view" })).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("graph-bottombar")).toBeNull();
    expect(screen.queryByRole("group", { name: "Direction" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand pinned nodes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Papers \(/ })).toBeNull();
    expect(screen.queryByText("Legend")).toBeNull();
    expect(screen.queryByTestId("graph-node-popup")).toBeNull();
    // Nothing selected, pending or failed: no summary row.
    expect(screen.queryByTestId("graph-summary")).toBeNull();
  });

  it("returns focus to the trigger on Escape and Close and keeps the chosen direction", async () => {
    renderGraph();
    await ready();

    let dialog = openSheet();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByRole("heading", { level: 2, name: "Graph controls" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "References" }));
    // Nothing is selected, so the toggle loads nothing and the sheet stays.
    expect(within(dialog).getByRole("button", { name: "References" })).toHaveAttribute("aria-pressed", "true");
    expect(api.related).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger()).toHaveFocus();

    dialog = openSheet();
    expect(within(dialog).getByRole("button", { name: "References" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger()).toHaveFocus();

    dialog = openSheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("opens the sheet at the bottom on phones and at the side on short landscape screens", async () => {
    const media = mockMatchMedia(() => true);
    renderGraph();
    await ready();
    expect(openSheet()).toHaveClass("panel", "panel--bottom");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));

    // 667×375: compact through (max-height: 500px), wider than a phone.
    act(() => media.set((query) => query.includes("max-height: 500px")));
    expect(openSheet()).toHaveClass("panel");
    expect(screen.getByRole("dialog")).not.toHaveClass("panel--bottom");
  });

  it("summarizes the selected paper in-flow and keeps its card and the legend in the sheet", async () => {
    renderGraph();
    await ready();
    selectSeedOnCanvas();

    const row = summary();
    expect(within(row).getByRole("button", { name: "Seed Paper" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Pin “Seed Paper”" })).toHaveAttribute("aria-pressed", "true");
    expect(within(row).getByRole("button", { name: "View details" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "1–30 — not loaded yet, tap to load" })).toBeInTheDocument();
    expect(screen.queryByTestId("graph-node-popup")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Pin “Seed Paper”" }));
    expect(within(summary()).getByRole("button", { name: "Pin “Seed Paper”" })).toHaveAttribute("aria-pressed", "false");
    expect(api.related).not.toHaveBeenCalled();

    // The title opens the sheet on the selected paper.
    fireEvent.click(within(summary()).getByRole("button", { name: "Seed Paper" }));
    const dialog = screen.getByRole("dialog", { name: "Graph controls" });
    const card = within(dialog).getByTestId("graph-node-popup");
    expect(within(card).getByRole("heading", { level: 2, name: "Seed Paper" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Pin “Seed Paper”" })).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog).getByText("Citers of “Seed Paper”")).toBeInTheDocument();
    expect(within(dialog).getByRole("navigation", { name: "Result ranges" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "View" })).toBeInTheDocument();
    expect(within(dialog).getByText("Legend")).toBeInTheDocument();
    expect(within(dialog).getByText("Pinned")).toBeInTheDocument();
    expect(within(dialog).getByText("Selected")).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(within(summary()).getByRole("button", { name: "Seed Paper" })).toHaveFocus();
  });

  it("switches the Controls and Papers tabs with clicks and arrow keys", async () => {
    renderGraph();
    await ready();
    const dialog = openSheet();

    const tablist = within(dialog).getByRole("tablist");
    const controlsTab = within(tablist).getByRole("tab", { name: "Controls" });
    const papersTab = within(tablist).getByRole("tab", { name: "Papers (2)" });
    expect(controlsTab).toHaveAttribute("aria-selected", "true");
    expect(papersTab).toHaveAttribute("aria-selected", "false");
    expect(papersTab).toHaveAttribute("tabindex", "-1");
    expect(within(dialog).getByRole("tabpanel", { name: "Controls" })).toBeInTheDocument();

    fireEvent.keyDown(controlsTab, { key: "ArrowRight" });
    expect(papersTab).toHaveAttribute("aria-selected", "true");
    expect(papersTab).toHaveFocus();
    const panel = within(dialog).getByRole("tabpanel", { name: "Papers (2)" });
    const list = within(panel).getByRole("complementary", { name: "Papers on the graph" });
    fireEvent.click(within(list).getByRole("button", { name: /^Other Paper/ }));
    expect(within(list).getByRole("button", { name: /^Other Paper/ })).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(papersTab, { key: "ArrowLeft" });
    expect(controlsTab).toHaveAttribute("aria-selected", "true");
    expect(controlsTab).toHaveFocus();
    expect(within(dialog).getByTestId("graph-node-popup")).toHaveTextContent("Other Paper");

    fireEvent.click(papersTab);
    expect(papersTab).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    // Reopening keeps the tab.
    expect(within(openSheet()).getByRole("tab", { name: "Papers (2)" })).toHaveAttribute("aria-selected", "true");
    expect(api.related).not.toHaveBeenCalled();
  });

  it("closes the sheet on a range load and shows its status in the summary row", async () => {
    renderGraph();
    await ready();
    selectSeedOnCanvas();
    const dialog = openSheet();

    const pending = deferred<RelatedRangeResponse>();
    api.related.mockImplementationOnce(() => pending.promise);
    const nav = within(dialog).getByRole("navigation", { name: "Result ranges" });
    fireEvent.click(within(nav).getByRole("button", { name: "1–30 — not loaded yet, tap to load" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(within(summary()).getByText("Loading 1–30…")).toBeInTheDocument();
    const body = api.related.mock.calls[0]![0] as RelatedRangeRequest;
    expect(body).toMatchObject({ source_group_key: "group:seed", range_start: 0, last: false });

    await act(async () => pending.resolve(rangeResponse(body)));
    expect(within(summary()).getByRole("button", { name: "Show results 1 to 30" })).toBeInTheDocument();
    expect(within(summary()).queryByText("Loading 1–30…")).toBeNull();
  });

  it("closes the sheet when a direction switch reloads the selected paper", async () => {
    renderGraph();
    await ready();
    selectSeedOnCanvas();
    fireEvent.click(within(summary()).getByRole("button", { name: /^1–30 — not loaded yet/ }));
    expect(await within(summary()).findByRole("button", { name: "Show results 1 to 30" })).toBeInTheDocument();

    api.related.mockImplementationOnce(() => Promise.reject(httpError(502)));
    fireEvent.click(within(openSheet()).getByRole("button", { name: "References" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.related).toHaveBeenLastCalledWith(expect.objectContaining({ direction: "cites", range_start: 0 }), expect.anything());

    expect(await within(summary()).findByText("The citation provider is unavailable right now.")).toBeInTheDocument();
    fireEvent.click(within(summary()).getByRole("button", { name: "Try again" }));
    expect(api.related).toHaveBeenCalledTimes(3);
    expect(await within(summary()).findByRole("button", { name: "Show results 1 to 30" })).toBeInTheDocument();
    expect(within(openSheet()).getByRole("button", { name: "References" })).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the sheet when Expand pinned nodes starts", async () => {
    api.topUp.mockResolvedValue({ nodes: [], edges: [], sources: [], range_size: 30, max_results: 10000 });
    renderGraph();
    await ready();
    fireEvent.click(within(openSheet()).getByRole("button", { name: "Expand pinned nodes" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(api.topUp).toHaveBeenCalledTimes(1));
    expect(api.related).not.toHaveBeenCalled();
  });

  it("announces an error that arrives while the sheet is open through the toast layer", async () => {
    renderGraph();
    await ready();
    selectSeedOnCanvas();
    const failing = deferred<RelatedRangeResponse>();
    api.related.mockImplementationOnce(() => failing.promise.then(() => Promise.reject(httpError(502))));
    fireEvent.click(within(summary()).getByRole("button", { name: /^1–30 — not loaded yet/ }));
    openSheet();

    await act(async () => failing.resolve(rangeResponse(api.related.mock.calls[0]![0] as RelatedRangeRequest)));
    const layer = document.querySelector("[data-live-layer]") as HTMLElement;
    expect(await within(layer).findByText("The citation provider is unavailable right now.")).toBeInTheDocument();
  });

  it("shows ranking progress and Continue in the summary row after the sheet closes", async () => {
    api.related.mockImplementation((body: RelatedRangeRequest) => Promise.resolve(rankingResponse(body, 500)));
    renderGraph();
    await ready();
    selectSeedOnCanvas();
    const nav = within(openSheet()).getByRole("navigation", { name: "Result ranges" });
    fireEvent.click(within(nav).getByRole("button", { name: /^1–30 — not loaded yet/ }));

    expect(screen.queryByRole("dialog")).toBeNull();
    // The scan did not advance on the re-request: stop at once.
    expect(
      await within(summary()).findByText("Still ranking: 500 of about 9,898 related papers collected so far."),
    ).toBeInTheDocument();
    expect(api.related).toHaveBeenCalledTimes(2);
    fireEvent.click(within(summary()).getByRole("button", { name: "Continue" }));
    expect(api.related).toHaveBeenCalledTimes(3);
  });

  it("shows the incomplete-links notice in the summary row without a selection", async () => {
    api.buildPaper.mockImplementation(() => Promise.resolve({ ...baseGraph(), edges_partial: true }));
    renderGraph();
    await ready();

    const row = summary();
    expect(within(row).getByText(/Some links between these papers couldn’t be loaded/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByTestId("graph-summary")).toBeNull();
  });
});

describe("GraphPage (manual)", () => {
  it("shows an entry-point empty state with a page heading and no key input", async () => {
    renderGraph("/graph");
    expect(await screen.findByTestId("empty-state")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Citation graph" })).toBeInTheDocument();
    expect(screen.queryByTestId("graph-bottombar")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("GraphPage (shared collection)", () => {
  const TOKEN = "a".repeat(43);
  const NEW_TOKEN = "b".repeat(43);
  const secondSeed = paper("hash:second", "group:second", "Second Seed");

  function renderCollectionGraph() {
    return renderWithProviders(
      <>
        <Link to={`/graph/collection/c1#share=${NEW_TOKEN}`}>Use the new link</Link>
        <Routes>
          <Route path="/graph/collection/:collectionId" element={<GraphPage mode="collection" />} />
          <Route path="/collections/:id" element={<p>Collection page</p>} />
        </Routes>
      </>,
      { route: `/graph/collection/c1#share=${TOKEN}` },
    );
  }

  function collectionReads(status: "ok" | "revoked") {
    http.get.mockImplementation((url: string) => {
      if (!url.startsWith("/collections/")) return Promise.resolve({ data: [] });
      return status === "ok" ? Promise.resolve({ data: { id: "c1" } }) : Promise.reject(httpError(404));
    });
  }

  beforeEach(() => {
    mockMatchMedia(() => false);
    engine.mounts = 0;
    api.buildCollection.mockReset().mockImplementation(() => Promise.resolve(baseGraph()));
    api.related.mockReset().mockImplementation((body: RelatedRangeRequest) => Promise.resolve(rangeResponse(body)));
    collectionReads("ok");
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    http.get.mockReset().mockImplementation(() => Promise.resolve({ data: [] }));
    restoreMatchMedia();
  });

  it("sends the read capability with the graph and the access check", async () => {
    renderCollectionGraph();
    await ready();

    const headers = { "X-Collection-Share-Token": TOKEN };
    expect(api.buildCollection).toHaveBeenCalledWith("c1", headers);
    expect(http.get).toHaveBeenCalledWith("/collections/c1", { headers });
  });

  it("clears the exploration when the read link is revoked, without rebuilding the graph", async () => {
    renderCollectionGraph();
    await ready();
    selectSeed();
    const late = deferred<RelatedRangeResponse>();
    let signal: AbortSignal | undefined;
    api.related.mockImplementationOnce((_body: RelatedRangeRequest, options: { signal?: AbortSignal }) => {
      signal = options.signal;
      return late.promise;
    });
    fireEvent.click(within(ranges()).getByRole("button", { name: /^1–30 — not loaded yet/ }));

    collectionReads("revoked");
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    expect(await screen.findByText("Collection unavailable or access no longer granted.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the collection" })).toHaveAttribute("href", `/collections/c1#share=${TOKEN}`);
    expect(screen.queryByTestId("force-graph-stub")).toBeNull();
    expect(screen.queryByTestId("graph-node-popup")).toBeNull();
    expect(screen.queryByTestId("graph-bottombar")).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(api.buildCollection).toHaveBeenCalledTimes(1);
  });

  it("shows the unavailable state when the graph itself is no longer readable", async () => {
    api.buildCollection.mockImplementation(() => Promise.reject(httpError(403)));
    renderCollectionGraph();

    expect(await screen.findByText("Collection unavailable or access no longer granted.")).toBeInTheDocument();
    expect(screen.queryByTestId("force-graph-stub")).toBeNull();
  });

  it("starts a fresh exploration for a new link and ignores the old scope's responses", async () => {
    api.buildCollection.mockImplementation((_id: string, headers: Record<string, string>) =>
      Promise.resolve(headers["X-Collection-Share-Token"] === NEW_TOKEN ? baseGraph(secondSeed) : baseGraph()),
    );
    renderCollectionGraph();
    await ready();
    const list = openPapers();
    fireEvent.click(within(list).getByRole("button", { name: "Pin “Other Paper”" }));
    fireEvent.click(within(list).getByRole("button", { name: /^Seed Paper/ }));
    const late = deferred<RelatedRangeResponse>();
    api.related.mockImplementationOnce(() => late.promise);
    fireEvent.click(within(ranges()).getByRole("button", { name: /^1–30 — not loaded yet/ }));

    fireEvent.click(screen.getByRole("link", { name: "Use the new link" }));
    await waitFor(() => expect(api.buildCollection).toHaveBeenCalledWith("c1", { "X-Collection-Share-Token": NEW_TOKEN }));
    await waitFor(() => expect(forceNode("group:second")).toBeDefined());
    await act(async () => late.resolve(rangeResponse(api.related.mock.calls[0]![0] as RelatedRangeRequest)));

    expect(forceNode("group:Related-0")).toBeUndefined();
    expect(engine.props.graphData.nodes).toHaveLength(2);
    expect(within(bar()).getByText("1 pinned")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-node-popup")).toBeNull();
  });

  it("goes back to the collection with its read link", async () => {
    renderCollectionGraph();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Collection page")).toBeInTheDocument();
  });
});
