import { mockRefresh } from "@/test/auth-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
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
  related: vi.fn(),
  topUp: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
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

function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {}, headers } });
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
    expect(screen.getByText(/Totals count what the citation provider can list/)).toBeInTheDocument();
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
    expect(screen.getByText("1–30 · first 10,000 of 50,000")).toBeInTheDocument();

    const { default: i18n } = await import("@/i18n");
    await act(async () => {
      await i18n.changeLanguage("it");
    });
    expect(screen.getByText("1–30 · primi 10.000 di 50.000")).toBeInTheDocument();
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
    fireEvent.click(within(bar()).getByRole("button", { name: "Retry" }));
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
    expect(within(bar()).getByRole("button", { name: "Retry" })).toBeDisabled();
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

    fireEvent.click(within(alert).getByRole("button", { name: /Retry/ }));
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
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    act(() => media.set(() => false));
    expect(within(bar()).getByText("Citers of “Seed Paper”")).toBeInTheDocument();
    expect(within(bar()).getByText("1 pinned")).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: "Most recent" })).toHaveAttribute("aria-pressed", "true");
    expect(within(ranges()).getByRole("button", { name: "Show results 1 to 30" })).toHaveAttribute("aria-current", "true");
    expect(api.related).toHaveBeenCalledTimes(1);
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
    fireEvent.click(within(summary()).getByRole("button", { name: "Retry" }));
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
