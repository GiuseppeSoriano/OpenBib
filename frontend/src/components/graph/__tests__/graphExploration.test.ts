import { describe, it, expect } from "vitest";
import {
  branchKey,
  buildRangeRequest,
  buildTopUpRequest,
  connectedGroupKeys,
  currentBranch,
  explorationReducer,
  exclusionsFor,
  initialExplorationState,
  MAX_EXCLUSIONS,
  modeSwitchAutoLoad,
  planTopUp,
  rangeControls,
  rangeWindow,
  visibleEdgeKeys,
  visibleNodeIds,
  type ExplorationAction,
  type ExplorationState,
  type Mode,
  type PendingRange,
  type PendingTopUp,
} from "@/components/graph/graphExploration";
import type {
  GraphEdge,
  GraphNode,
  GraphResponse,
  PaperMetadata,
  RelatedRangeResponse,
  TopUpResponse,
  TopUpSourceResult,
} from "@/types";

/* ── Fixtures ─────────────────────────────────────────────── */

function paper(key: string): PaperMetadata {
  return {
    canonical_key: `hash:${key}`,
    paper_group_key: key,
    title: key,
    authors: [],
    abstract: null,
    publication_date: null,
    doi: null,
    arxiv_id: null,
    venue: null,
    paper_type: null,
    topics: [],
    keywords: [],
    open_access: null,
    pdf_url: null,
    cited_by_count: 1,
    reference_count: null,
    provider_source: "openalex",
    provider_sources: ["openalex"],
  };
}

function node(id: string, isSeed = false): GraphNode {
  const version = paper(id);
  return {
    id,
    label: id,
    type: "paper",
    paper_group_key: id,
    version_count: 1,
    selected_version: version,
    versions: [version],
    is_seed: isSeed,
  };
}

const CITERS: Mode = { direction: "cited_by", order: "cited_by_count" };
const RECENT: Mode = { direction: "cited_by", order: "recent" };
const REFS: Mode = { direction: "cites", order: "cited_by_count" };

function relEdge(source: string, item: string, mode: Mode): GraphEdge {
  return mode.direction === "cited_by"
    ? { source: item, target: source, relation_type: "cited_by" }
    : { source, target: item, relation_type: "cited_by" };
}

function baseGraph(seeds: string[], others: string[] = [], edges: GraphEdge[] = [], extra: Partial<GraphResponse> = {}): GraphResponse {
  return {
    active_paper_key: `hash:${seeds[0] ?? "none"}`,
    active_paper_group_key: seeds[0] ?? "none",
    nodes: [...seeds.map((id) => node(id, true)), ...others.map((id) => node(id))],
    edges,
    ...extra,
  };
}

function rangeResponse(
  source: string,
  keys: string[],
  mode: Mode = CITERS,
  extra: Partial<RelatedRangeResponse> = {},
): RelatedRangeResponse {
  const start = extra.range_start ?? 0;
  return {
    source_key: `hash:${source}`,
    source_group_key: source,
    direction: mode.direction,
    order: mode.order,
    nodes: keys.map((id) => node(id)),
    edges: keys.map((id) => relEdge(source, id, mode)),
    group_keys: keys,
    range_start: start,
    range_end: start + keys.length,
    range_size: 30,
    max_results: 10000,
    total_available: start + keys.length,
    total_exact: true,
    total_capped: false,
    provider_total: start + keys.length,
    scanned: start + keys.length,
    has_more: false,
    exhausted: keys.length < 30,
    clamped: false,
    scan_incomplete: false,
    snapshot_id: "snap",
    reason: null,
    ...extra,
  };
}

function sourceResult(source: string, added: string[], extra: Partial<TopUpSourceResult> = {}): TopUpSourceResult {
  return {
    source_key: `hash:${source}`,
    source_group_key: source,
    added_group_keys: added,
    connected_count: added.length,
    total_available: 100,
    total_exact: true,
    total_capped: false,
    provider_total: 100,
    exhausted: false,
    reason: null,
    error: null,
    ...extra,
  };
}

function topUpResponse(results: TopUpSourceResult[], mode: Mode = CITERS): TopUpResponse {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const result of results) {
    for (const id of result.added_group_keys) {
      nodes.push(node(id));
      edges.push(relEdge(result.source_group_key, id, mode));
    }
  }
  return { nodes, edges, sources: results, range_size: 30, max_results: 10000 };
}

const ids = (prefix: string, count: number, from = 0) => Array.from({ length: count }, (_, i) => `${prefix}${from + i}`);

let seq = 0;

function reduce(state: ExplorationState, ...actions: ExplorationAction[]): ExplorationState {
  return actions.reduce(explorationReducer, state);
}

function startRange(
  state: ExplorationState,
  sourceId: string,
  rangeIndex: number | null = 0,
  mode: Mode = state.mode,
  last = false,
  retireOtherModes = false,
): [ExplorationState, number] {
  const id = ++seq;
  const pending: PendingRange = {
    kind: "range",
    id,
    sourceId,
    sourceKey: `hash:${sourceId}`,
    mode,
    rangeIndex,
    last,
    ...(retireOtherModes ? { retireOtherModes } : {}),
    pinEpoch: state.pinEpoch,
    unpinEpoch: state.unpinEpoch,
    autoContinue: 0,
    scanned: null,
    providerTotal: null,
  };
  return [explorationReducer(state, { type: "requestStarted", pending, exclusionsCapped: false }), id];
}

function loadRange(
  state: ExplorationState,
  sourceId: string,
  keys: string[],
  extra: Partial<RelatedRangeResponse> = {},
): ExplorationState {
  const start = extra.range_start ?? 0;
  const [started, id] = startRange(state, sourceId, start / 30);
  return explorationReducer(started, { type: "rangeLoaded", id, response: rangeResponse(sourceId, keys, state.mode, extra) });
}

function startTopUp(state: ExplorationState, batch: string[], mode: Mode = state.mode): [ExplorationState, number] {
  const id = ++seq;
  const pending: PendingTopUp = { kind: "topup", id, mode, batch, pinEpoch: state.pinEpoch, unpinEpoch: state.unpinEpoch };
  return [explorationReducer(state, { type: "requestStarted", pending, exclusionsCapped: false }), id];
}

function loaded(seeds: string[], others: string[] = [], edges: GraphEdge[] = []): ExplorationState {
  return explorationReducer(initialExplorationState(), { type: "baseLoaded", base: baseGraph(seeds, others, edges) });
}

const labels = (items: { start: number; end: number }[]) => items.map((item) => `${item.start}–${item.end}`);

/* ── rangeWindow ──────────────────────────────────────────── */

describe("rangeWindow", () => {
  it("shows first, previous, current, next and last", () => {
    const items = rangeWindow(1000, 9, 30);
    expect(labels(items)).toEqual(["1–30", "241–270", "271–300", "301–330", "991–1000"]);
    expect(items.filter((item) => item.current).map((item) => item.index)).toEqual([9]);
  });

  it("omits duplicates at the edges", () => {
    expect(labels(rangeWindow(1000, 0))).toEqual(["1–30", "31–60", "991–1000"]);
    expect(labels(rangeWindow(1000, 1))).toEqual(["1–30", "31–60", "61–90", "991–1000"]);
    expect(labels(rangeWindow(1000, 33))).toEqual(["1–30", "961–990", "991–1000"]);
    expect(labels(rangeWindow(45, 0))).toEqual(["1–30", "31–45"]);
    expect(labels(rangeWindow(30, 0))).toEqual(["1–30"]);
    expect(rangeWindow(0, 0)).toEqual([]);
  });

  it("clamps an active range beyond the end", () => {
    const items = rangeWindow(100, 50);
    expect(labels(items)).toEqual(["1–30", "61–90", "91–100"]);
    expect(items[items.length - 1]!.current).toBe(true);
    expect(rangeWindow(100, -3)[0]!.current).toBe(true);
  });
});

/* ── Base, selection and pins ─────────────────────────────── */

describe("baseLoaded and pins", () => {
  it("pins every seed, in base order, and reads the range size with a fallback", () => {
    const state = loaded(["s2", "s1"], ["x"]);
    expect([...state.pinned]).toEqual(["s2", "s1"]);
    expect(state.pinOrder).toEqual(["s2", "s1"]);
    expect(state.rangeSize).toBe(30);
    expect(state.maxResults).toBe(10000);
    const custom = explorationReducer(initialExplorationState(), {
      type: "baseLoaded",
      base: baseGraph(["s"], [], [], { related_range_size: 20, related_max_results: 500 }),
    });
    expect(custom.rangeSize).toBe(20);
    expect(custom.maxResults).toBe(500);
  });

  it("select never fetches, pins or removes anything", () => {
    let state = loadRange(loaded(["s"]), "s", ["a", "b"]);
    const visible = visibleNodeIds(state);
    state = explorationReducer(state, { type: "select", id: "a" });
    expect(state.selectedId).toBe("a");
    expect(state.pending).toBeNull();
    expect(state.pinned.has("a")).toBe(false);
    expect(visibleNodeIds(state)).toEqual(visible);
    expect(rangeControls(state, "a").loaded).toBe(false);
  });

  it("togglePin changes only the pin set and epochs", () => {
    const before = loadRange(loaded(["s"]), "s", ["a", "b"]);
    const pinned = explorationReducer(before, { type: "togglePin", id: "a" });
    expect(pinned.pinned.has("a")).toBe(true);
    expect(pinned.pinOrder).toEqual(["s", "a"]);
    expect(pinned.pinEpoch).toBe(before.pinEpoch + 1);
    expect(pinned.unpinEpoch).toBe(before.unpinEpoch);
    expect(pinned.branches).toBe(before.branches);
    expect(visibleNodeIds(pinned)).toEqual(visibleNodeIds(before));

    const unpinned = explorationReducer(pinned, { type: "togglePin", id: "a" });
    expect(unpinned.pinned.has("a")).toBe(false);
    expect(unpinned.unpinEpoch).toBe(before.unpinEpoch + 1);
    expect(unpinned.branches).toBe(before.branches);

    let toggled = before;
    for (let i = 0; i < 5; i++) toggled = explorationReducer(toggled, { type: "togglePin", id: "b" });
    expect(toggled.pending).toBeNull();
    expect(toggled.pinned.has("b")).toBe(true);
    expect(toggled.branches).toBe(before.branches);
  });

  it("drag pins but never unpins", () => {
    const state = loaded(["s"], ["x"]);
    const dragged = explorationReducer(state, { type: "pinFromDrag", id: "x" });
    expect(dragged.pinned.has("x")).toBe(true);
    expect(explorationReducer(dragged, { type: "pinFromDrag", id: "x" })).toBe(dragged);
  });
});

/* ── Ranges ───────────────────────────────────────────────── */

describe("rangeLoaded", () => {
  it("replaces only the branch's unpinned members and keeps pins, shared and base nodes", () => {
    let state = loaded(["x", "y"], ["base"]);
    state = loadRange(state, "y", ["shared", "yb"]);
    state = loadRange(state, "x", ["a", "b", "shared", "c"]);
    state = explorationReducer(state, { type: "togglePin", id: "a" });
    const edgesBefore = currentBranch(state, "x")!.edgeKeys;
    expect(edgesBefore).toHaveLength(4);

    state = loadRange(state, "x", ["d", "e"], { range_start: 30 });
    const x = currentBranch(state, "x")!;
    expect(x.memberIds).toEqual(["d", "e", "a"]);
    expect(x.rangeIndex).toBe(1);
    expect(x.edgeKeys).toHaveLength(3);

    const visible = visibleNodeIds(state);
    for (const id of ["x", "y", "base", "a", "shared", "yb", "d", "e"]) expect(visible.has(id)).toBe(true);
    expect(visible.has("b")).toBe(false);
    expect(visible.has("c")).toBe(false);
    expect(currentBranch(state, "y")!.memberIds).toEqual(["shared", "yb"]);
    const edges = visibleEdgeKeys(state);
    expect(edges.has("b__x__cited_by")).toBe(false);
    expect(edges.has("shared__y__cited_by")).toBe(true);
    expect(edges.has("a__x__cited_by")).toBe(true);
  });

  it("defers repartition: an unpinned member stays until its branch is navigated", () => {
    let state = loadRange(loaded(["x"]), "x", ["a", "b", "c"]);
    state = explorationReducer(state, { type: "togglePin", id: "a" });
    state = loadRange(state, "x", ["d", "e", "f"], { range_start: 30 });
    expect(currentBranch(state, "x")!.memberIds).toEqual(["d", "e", "f", "a"]);

    state = explorationReducer(state, { type: "togglePin", id: "a" });
    expect(visibleNodeIds(state).has("a")).toBe(true);
    expect(rangeControls(state, "x").pinsChanged).toBe(true);

    state = loadRange(state, "x", ["d", "e", "f"], { range_start: 30 });
    expect(visibleNodeIds(state).has("a")).toBe(false);
    expect(rangeControls(state, "x").pinsChanged).toBe(false);
  });

  it("drops pinned items and the source defensively", () => {
    let state = loaded(["x", "p"]);
    state = loadRange(state, "x", ["x", "p", "a", "a"]);
    expect(currentBranch(state, "x")!.memberIds).toEqual(["a"]);
  });

  it("ignores stale responses and failures", () => {
    const state = loaded(["x"]);
    const [started, id] = startRange(state, "x");
    const [superseded] = startRange(started, "x", 1);
    const late = explorationReducer(superseded, { type: "rangeLoaded", id, response: rangeResponse("x", ["a"]) });
    expect(late).toBe(superseded);
    expect(explorationReducer(superseded, { type: "requestFailed", id, kind: "server", now: 0 })).toBe(superseded);
  });

  it("keeps every branch on failure and records the error", () => {
    let state = loadRange(loaded(["x"]), "x", ["a", "b"]);
    const [started, id] = startRange(state, "x", 1);
    state = explorationReducer(started, { type: "requestFailed", id, kind: "rate_limited", retryAfter: 7, now: 1000 });
    expect(state.pending).toBeNull();
    expect(currentBranch(state, "x")!.memberIds).toEqual(["a", "b"]);
    expect(state.error).toEqual({
      request: { kind: "range", sourceId: "x", mode: CITERS, rangeIndex: 1, last: false },
      kind: "rate_limited",
      retryAfter: 7,
      retryAt: 8000,
    });

    const [again, second] = startRange(state, "x", 1);
    expect(again.error).toBeNull();
    const failed = explorationReducer(again, { type: "requestFailed", id: second, kind: "provider", now: 0 });
    expect(failed.error?.kind).toBe("provider");
    expect(failed.error?.retryAfter).toBeNull();
  });

  it("sets notices for adjusted, empty, all-pinned and no-provider results", () => {
    const base = explorationReducer(loaded(["x", "p"]), { type: "select", id: "x" });
    const adjusted = loadRange(base, "x", ["a"], { range_start: 60, clamped: true, total_available: 61 });
    expect(adjusted.notice).toEqual({ kind: "rangeAdjusted", params: { total: 61, start: 61, end: 61 } });
    expect(currentBranch(adjusted, "x")!.rangeIndex).toBe(2);

    const empty = loadRange(base, "x", [], { provider_total: 0, total_available: 0 });
    expect(empty.notice).toEqual({ kind: "empty", params: { direction: "cited_by" } });
    // An empty branch is exhausted, so "Expand pinned" skips it.
    expect(currentBranch(empty, "x")!.exhausted).toBe(true);
    expect(planTopUp(empty).skippedExhausted).toEqual(["x"]);

    const allPinned = loadRange(base, "x", [], { provider_total: 1, total_available: 0 });
    expect(allPinned.notice).toEqual({ kind: "allPinned" });
    expect(loadRange(base, "x", ["p"]).notice).toEqual({ kind: "allPinned" });

    const noId = loadRange(base, "x", [], { reason: "no_provider_id", provider_total: null, total_available: 0 });
    expect(noId.notice).toEqual({ kind: "noProviderId" });
    expect(explorationReducer(noId, { type: "dismissNotice" }).notice).toBeNull();
  });
});

/* ── Selection, mode switches and pending requests ─────────── */

describe("mode switches", () => {
  it("auto-loads for a selected source with a branch and retires its old-mode branch on arrival", () => {
    let state = loaded(["x", "y"]);
    state = loadRange(state, "y", ["shared", "yb"]);
    state = loadRange(state, "x", ["a", "b", "shared"]);
    state = reduce(state, { type: "select", id: "x" }, { type: "togglePin", id: "a" });
    const oldKey = branchKey("x", "cited_by", "cited_by_count");

    const before = state;
    state = explorationReducer(state, { type: "setMode", mode: { order: "recent" } });
    expect(modeSwitchAutoLoad(before)).toBe("x");
    expect(state.mode).toEqual(RECENT);
    // Nothing is retired until the new range arrives.
    expect(state.branches[oldKey]!.active).toBe(true);

    state = loadRange(state, "x", ["n1", "n2"]);
    const old = state.branches[oldKey]!;
    expect(old.active).toBe(false);
    expect(old.memberIds).toEqual(["a"]);
    expect(old.rangeIndex).toBeNull();
    expect(old.totalAvailable).toBe(3);
    expect(currentBranch(state, "x")!.memberIds).toEqual(["n1", "n2"]);
    expect(state.activeBySource.x).toBe(branchKey("x", "cited_by", "recent"));

    const visible = visibleNodeIds(state);
    for (const id of ["a", "shared", "yb", "n1", "n2", "x", "y"]) expect(visible.has(id)).toBe(true);
    expect(visible.has("b")).toBe(false);
    expect(visibleEdgeKeys(state).has("b__x__cited_by")).toBe(false);
    expect(visibleEdgeKeys(state).has("a__x__cited_by")).toBe(true);
  });

  it("does not auto-load without a selected, loaded source", () => {
    const state = loadRange(loaded(["x"]), "x", ["a"]);
    expect(modeSwitchAutoLoad(state)).toBeNull();
    expect(modeSwitchAutoLoad(explorationReducer(state, { type: "select", id: "a" }))).toBeNull();
    const [loading] = startRange(explorationReducer(loaded(["x"]), { type: "select", id: "x" }), "x");
    expect(modeSwitchAutoLoad(loading)).toBe("x");
  });

  it("ignores stale responses across rapid A→B→A switches and keeps pins", () => {
    let state = loadRange(loaded(["x"]), "x", ["a", "k"]);
    state = reduce(state, { type: "select", id: "x" }, { type: "togglePin", id: "k" });
    state = explorationReducer(state, { type: "setMode", mode: { order: "recent" } });
    const [toB, idB] = startRange(state, "x", 0, state.mode, false, true);
    state = explorationReducer(toB, { type: "setMode", mode: { order: "cited_by_count" } });
    expect(state.pending).toBeNull();
    const [toA, idA] = startRange(state, "x", 0, state.mode, false, true);

    const late = explorationReducer(toA, { type: "rangeLoaded", id: idB, response: rangeResponse("x", ["b1"], RECENT) });
    expect(late).toBe(toA);
    state = explorationReducer(toA, { type: "rangeLoaded", id: idA, response: rangeResponse("x", ["a2"]) });
    expect(currentBranch(state, "x")!.memberIds).toEqual(["a2", "k"]);
    expect(state.branches[branchKey("x", "cited_by", "recent")]).toBeUndefined();
    expect(state.pinned.has("k")).toBe(true);
    const visible = visibleNodeIds(state);
    expect(visible.has("k")).toBe(true);
    expect(visible.has("b1")).toBe(false);
    expect(visible.has("a")).toBe(false);
  });

  it("navigating within a mode keeps the source's topped-up branch of another mode", () => {
    let state = loadRange(loaded(["s"]), "s", ["a", "b"], { total_available: 100, has_more: true, exhausted: false });
    state = explorationReducer(state, { type: "setMode", mode: { direction: "cites" } });
    const [started, id] = startTopUp(state, ["s"]);
    state = explorationReducer(started, { type: "topUpLoaded", id, response: topUpResponse([sourceResult("s", ["r1", "r2"])], REFS) });
    state = reduce(state, { type: "setMode", mode: { direction: "cited_by" } }, { type: "select", id: "s" });

    state = loadRange(state, "s", ["c", "d"], { range_start: 30, total_available: 100 });
    const refs = state.branches[branchKey("s", "cites", "cited_by_count")]!;
    expect(refs.active).toBe(true);
    expect(refs.memberIds).toEqual(["r1", "r2"]);
    expect(currentBranch(state, "s")!.memberIds).toEqual(["c", "d"]);
    const visible = visibleNodeIds(state);
    for (const member of ["r1", "r2", "c", "d"]) expect(visible.has(member)).toBe(true);
    expect(visible.has("a")).toBe(false);
  });

  it("the mode-switch auto-load retires every other branch of the source", () => {
    let state = loadRange(loaded(["s"]), "s", ["a", "b"]);
    state = explorationReducer(state, { type: "setMode", mode: { direction: "cites" } });
    const [topping, topUpId] = startTopUp(state, ["s"]);
    state = explorationReducer(topping, { type: "topUpLoaded", id: topUpId, response: topUpResponse([sourceResult("s", ["r1"])], REFS) });
    state = explorationReducer(state, { type: "select", id: "s" });

    // Back to citers with s selected: its references results are replaced
    // even though the citers branch is still the source's primary one.
    const before = state;
    state = explorationReducer(state, { type: "setMode", mode: { direction: "cited_by" } });
    expect(modeSwitchAutoLoad(before)).toBe("s");
    const [started, id] = startRange(state, "s", 0, CITERS, false, true);
    state = explorationReducer(started, { type: "rangeLoaded", id, response: rangeResponse("s", ["c"]) });
    const refs = state.branches[branchKey("s", "cites", "cited_by_count")]!;
    expect(refs.active).toBe(false);
    expect(refs.memberIds).toEqual([]);
    expect(visibleNodeIds(state).has("r1")).toBe(false);
    expect(currentBranch(state, "s")!.memberIds).toEqual(["c"]);
  });

  it("select drops a pending range of another source but keeps a pending top-up; setMode drops any", () => {
    const state = explorationReducer(loaded(["x", "y"]), { type: "select", id: "x" });
    const [ranging] = startRange(state, "x");
    expect(explorationReducer(ranging, { type: "select", id: "y" }).pending).toBeNull();
    expect(explorationReducer(ranging, { type: "select", id: "x" }).pending).toBe(ranging.pending);

    const [topping] = startTopUp(state, ["x"]);
    expect(explorationReducer(topping, { type: "select", id: "y" }).pending).toBe(topping.pending);
    expect(explorationReducer(topping, { type: "setMode", mode: { direction: "cites" } }).pending).toBeNull();
    expect(explorationReducer(ranging, { type: "setMode", mode: { direction: "cites" } }).pending).toBeNull();
    expect(explorationReducer(ranging, { type: "setMode", mode: { direction: "cited_by" } })).toBe(ranging);
  });

  it("versionChanged resets that source's branch", () => {
    let state = loadRange(loaded(["x"]), "x", ["a", "b"]);
    state = explorationReducer(state, { type: "togglePin", id: "a" });
    state = explorationReducer(state, { type: "versionChanged", groupId: "x", canonicalKey: "hash:x-v2" });
    const branch = state.branches[branchKey("x", "cited_by", "cited_by_count")]!;
    expect(branch.active).toBe(false);
    expect(branch.memberIds).toEqual(["a"]);
    expect(state.activeBySource.x).toBeUndefined();
    expect(rangeControls(state, "x").loaded).toBe(false);
    expect(visibleNodeIds(state).has("x")).toBe(true);
    expect(explorationReducer(state, { type: "versionChanged", groupId: "x", canonicalKey: "hash:x-v2" })).toBe(state);
  });

  it("versionChanged forgets that the old version had no provider id", () => {
    const noId: Partial<RelatedRangeResponse> = { reason: "no_provider_id", provider_total: null, total_available: 0 };
    let state = explorationReducer(loaded(["x"]), { type: "select", id: "x" });
    state = loadRange(state, "x", [], noId);
    state = explorationReducer(state, { type: "setMode", mode: { direction: "cites" } });
    state = loadRange(state, "x", [], noId);
    expect(state.branches[branchKey("x", "cited_by", "cited_by_count")]!.active).toBe(false);
    expect(planTopUp(state).skippedNoProvider).toEqual(["x"]);

    state = explorationReducer(state, { type: "versionChanged", groupId: "x", canonicalKey: "hash:x-v2" });
    for (const branch of Object.values(state.branches)) {
      expect(branch.reason).toBeNull();
      expect(branch.exhausted).toBe(false);
    }
    const plan = planTopUp(state);
    expect(plan.skippedNoProvider).toEqual([]);
    expect(plan.toRequest.map((item) => item.sourceId)).toEqual(["x"]);
  });
});

/* ── Range controls and request bodies ────────────────────── */

describe("rangeControls", () => {
  it("offers 1–30 as current but not loaded before the first load", () => {
    const controls = rangeControls(loaded(["x"]), "x");
    expect(controls.loaded).toBe(false);
    expect(controls.items).toEqual([
      { kind: "range", index: 0, start: 1, end: 30, current: true, loaded: false, gapBefore: false },
    ]);
  });

  it("windows an exact total and marks gaps", () => {
    const state = loadRange(loaded(["x"]), "x", ids("r", 30, 271), { range_start: 270, total_available: 1000, has_more: true });
    const controls = rangeControls(state, "x");
    expect(controls.items.map((item) => (item.kind === "range" ? `${item.start}–${item.end}` : "last"))).toEqual([
      "1–30",
      "241–270",
      "271–300",
      "301–330",
      "991–1000",
    ]);
    expect(controls.items.map((item) => item.gapBefore)).toEqual([false, true, false, false, true]);
    expect(controls.summary).toMatchObject({ start: 271, end: 300, total: 1000, totalExact: true });
  });

  it("replaces the last numeric range with Last when the total is an estimate", () => {
    const state = loadRange(loaded(["x"]), "x", ids("r", 30), { total_available: 400, total_exact: false, has_more: true });
    const items = rangeControls(state, "x").items;
    expect(items.map((item) => (item.kind === "range" ? `${item.start}–${item.end}` : "last"))).toEqual([
      "1–30",
      "31–60",
      "last",
    ]);
  });

  it("builds range requests that exclude pins other than the source", () => {
    let state = loaded(["x", "p"]);
    state = explorationReducer(state, { type: "togglePin", id: "q" });
    const { body, capped } = buildRangeRequest(
      state,
      { kind: "range", sourceId: "x", mode: REFS, rangeIndex: 3, last: false },
      "hash:x",
    );
    expect(body).toEqual({
      source_key: "hash:x",
      source_group_key: "x",
      direction: "cites",
      order: "cited_by_count",
      range_start: 90,
      last: false,
      exclude_group_keys: ["p", "q"],
    });
    expect(capped).toBe(false);
  });

  it("caps exclusions at the most recent pins", () => {
    let state = loaded(["x"]);
    for (const id of ids("p", MAX_EXCLUSIONS + 5)) state = explorationReducer(state, { type: "togglePin", id });
    const exclusions = exclusionsFor(state, "x");
    expect(exclusions.capped).toBe(true);
    expect(exclusions.keys).toHaveLength(MAX_EXCLUSIONS);
    expect(exclusions.keys[0]).toBe("p5");
    expect(exclusions.keys[MAX_EXCLUSIONS - 1]).toBe(`p${MAX_EXCLUSIONS + 4}`);
  });
});

/* ── Top-up ───────────────────────────────────────────────── */

describe("planTopUp", () => {
  it("skips a full branch and tops up a deficient one with its connected keys", () => {
    let state = loaded(["full", "partial"]);
    state = loadRange(state, "full", ids("f", 30), { total_available: 100, has_more: true, exhausted: false });
    state = loadRange(state, "partial", ids("p", 20), { total_available: 50, total_exact: false, has_more: true, exhausted: false });
    const plan = planTopUp(state);
    expect(plan.skippedFull).toEqual(["full"]);
    expect(plan.toRequest).toEqual([{ sourceId: "partial", connectedGroupKeys: ids("p", 20), need: 10 }]);
    expect(plan.upTo).toBe(10);
  });

  it("skips an exhausted branch until something is unpinned", () => {
    let state = loadRange(loaded(["x"]), "x", ids("e", 20), { exhausted: true });
    expect(planTopUp(state).skippedExhausted).toEqual(["x"]);
    state = explorationReducer(state, { type: "togglePin", id: "other" });
    expect(planTopUp(state).skippedExhausted).toEqual(["x"]);
    state = explorationReducer(state, { type: "togglePin", id: "other" });
    expect(planTopUp(state).toRequest.map((item) => item.sourceId)).toEqual(["x"]);
  });

  it("needs a full range for a source with no results in this mode", () => {
    let state = loadRange(loaded(["x", "y"]), "x", ids("a", 30));
    state = explorationReducer(state, { type: "setMode", mode: { direction: "cites" } });
    const plan = planTopUp(state);
    expect(plan.toRequest).toEqual([
      { sourceId: "x", connectedGroupKeys: [], need: 30 },
      { sourceId: "y", connectedGroupKeys: [], need: 30 },
    ]);
  });

  it("counts neither the source nor pinned neighbours, and counts shared groups per branch", () => {
    let state = loaded(["x", "y"]);
    state = loadRange(state, "x", ["shared", "a", "b"], { exhausted: false });
    state = loadRange(state, "y", ["shared", "c"], { exhausted: false });
    state = explorationReducer(state, { type: "togglePin", id: "a" });
    expect(connectedGroupKeys(state, "x")).toEqual(["shared", "b"]);
    // "a" is a pinned source now too, with no results of its own yet.
    expect(planTopUp(state).toRequest).toEqual([
      { sourceId: "x", connectedGroupKeys: ["shared", "b"], need: 28 },
      { sourceId: "y", connectedGroupKeys: ["shared", "c"], need: 28 },
      { sourceId: "a", connectedGroupKeys: [], need: 30 },
    ]);
  });

  it("skips sources without a provider id", () => {
    const state = loadRange(loaded(["x"]), "x", [], { reason: "no_provider_id", total_available: 0 });
    expect(planTopUp(state).skippedNoProvider).toEqual(["x"]);
    expect(planTopUp(state).toRequest).toEqual([]);
  });

  it("asks for confirmation above 20 sources and chunks requests by 10", () => {
    const state = loaded(ids("s", 25));
    const plan = planTopUp(state);
    expect(plan.needsConfirmation).toBe(true);
    expect(plan.upTo).toBe(25 * 30);
    expect(plan.chunks.map((chunk) => chunk.length)).toEqual([10, 10, 5]);
    expect(planTopUp(loaded(ids("s", 20))).needsConfirmation).toBe(false);
  });

  it("builds top-up bodies from the current branches", () => {
    let state = loadRange(loaded(["x", "y"]), "x", ["a", "b"], { exhausted: false });
    state = explorationReducer(state, { type: "togglePin", id: "b" });
    const { body } = buildTopUpRequest(state, { kind: "topup", mode: CITERS, batch: ["x", "y"] }, (id) => `hash:${id}`);
    expect(body).toEqual({
      direction: "cited_by",
      order: "cited_by_count",
      target_per_source: 30,
      exclude_group_keys: ["x", "y", "b"],
      sources: [
        { source_key: "hash:x", source_group_key: "x", connected_group_keys: ["a"] },
        { source_key: "hash:y", source_group_key: "y", connected_group_keys: [] },
      ],
    });
  });
});

describe("topUpLoaded and Expand pinned", () => {
  it("appends members and never retires another branch of the same source", () => {
    let state = loadRange(loaded(["x"]), "x", ["a", "b"]);
    state = explorationReducer(state, { type: "setMode", mode: { direction: "cites" } });
    const [started, id] = startTopUp(state, ["x"]);
    state = explorationReducer(started, {
      type: "topUpLoaded",
      id,
      response: topUpResponse([sourceResult("x", ["r1", "a"])], REFS),
    });
    const refs = currentBranch(state, "x")!;
    expect(refs.memberIds).toEqual(["r1", "a"]);
    expect(refs.rangeIndex).toBeNull();
    const citers = state.branches[branchKey("x", "cited_by", "cited_by_count")]!;
    expect(citers.active).toBe(true);
    expect(citers.memberIds).toEqual(["a", "b"]);
    expect(visibleNodeIds(state).has("b")).toBe(true);
    // The range-loaded branch stays the source's primary one.
    expect(state.activeBySource.x).toBe(citers.key);
  });

  it("keeps a range-navigated branch's range and appends after it", () => {
    let state = loadRange(loaded(["x"]), "x", ids("a", 20), { range_start: 30, total_available: 50, exhausted: false, has_more: true });
    const [started, id] = startTopUp(state, ["x"]);
    state = explorationReducer(started, { type: "topUpLoaded", id, response: topUpResponse([sourceResult("x", ids("t", 10))]) });
    const branch = currentBranch(state, "x")!;
    expect(branch.rangeIndex).toBe(1);
    expect(branch.memberIds).toEqual([...ids("a", 20), ...ids("t", 10)]);
    expect(branch.edgeKeys).toHaveLength(30);
  });

  it("reports sources that failed", () => {
    const [started, id] = startTopUp(loaded(["x", "y"]), ["x", "y"]);
    const state = explorationReducer(started, {
      type: "topUpLoaded",
      id,
      response: topUpResponse([sourceResult("x", ["a"]), sourceResult("y", [], { error: "timeout" })]),
    });
    expect(state.notice).toEqual({ kind: "partialTopUp", params: { done: 1, total: 2, failed: 1 } });
    expect(state.branches[branchKey("y", "cited_by", "cited_by_count")]).toBeUndefined();
  });

  it("records exhaustion against the unpin epoch of the request", () => {
    const [started, id] = startTopUp(loaded(["x"]), ["x"]);
    const state = explorationReducer(started, {
      type: "topUpLoaded",
      id,
      response: topUpResponse([sourceResult("x", ["a"], { exhausted: true })]),
    });
    expect(planTopUp(state).skippedExhausted).toEqual(["x"]);
  });

  it("notices when there is nothing to expand", () => {
    const state = explorationReducer(loaded(["x"]), { type: "expandNothing" });
    expect(state.notice).toEqual({ kind: "nothingToExpand", params: { count: 30 } });
  });

  it("runs every chunk, pausing on 429 and failing on other errors", () => {
    const sources = ids("s", 25);
    let state = loaded(sources);
    state = explorationReducer(state, { type: "expandPlanned", sourceIds: sources, upTo: 750 });
    expect(state.expand?.phase).toBe("confirm");
    state = explorationReducer(state, { type: "expandConfirmed" });
    expect(state.expand?.phase).toBe("running");

    let [started, id] = startTopUp(state, sources.slice(0, 10));
    state = explorationReducer(started, {
      type: "topUpLoaded",
      id,
      response: topUpResponse(sources.slice(0, 10).map((source) => sourceResult(source, [`${source}-n`]))),
    });
    expect(state.expand?.queue).toEqual(sources.slice(10));
    expect(state.expand?.added).toBe(10);

    [started, id] = startTopUp(state, sources.slice(10, 20));
    state = explorationReducer(started, { type: "requestFailed", id, kind: "rate_limited", retryAfter: 5, now: 100 });
    expect(state.expand).toMatchObject({ phase: "paused", retryAfter: 5, resumeAt: 5100 });
    expect(state.expand?.queue).toEqual(sources.slice(10));
    expect(state.error).toBeNull();
    state = explorationReducer(state, { type: "expandResumed" });
    expect(state.expand?.phase).toBe("running");

    [started, id] = startTopUp(state, sources.slice(10, 20));
    state = explorationReducer(started, { type: "requestFailed", id, kind: "network", now: 0 });
    expect(state.expand?.phase).toBe("failed");
    expect(state.error?.request).toEqual({ kind: "topup", mode: CITERS, batch: sources.slice(10, 20) });
    state = explorationReducer(state, { type: "expandResumed" });
    expect(state.error).toBeNull();

    [started, id] = startTopUp(state, sources.slice(10, 20));
    state = explorationReducer(started, {
      type: "topUpLoaded",
      id,
      response: topUpResponse(sources.slice(10, 20).map((source) => sourceResult(source, [], { exhausted: true }))),
    });
    [started, id] = startTopUp(state, sources.slice(20));
    state = explorationReducer(started, {
      type: "topUpLoaded",
      id,
      response: topUpResponse(sources.slice(20).map((source, index) => sourceResult(source, [], { error: index ? null : "provider_unavailable" }))),
    });
    expect(state.expand).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.notice).toEqual({ kind: "partialTopUp", params: { done: 24, total: 25, failed: 1 } });
  });

  it("drops a source unpinned during the run from the queue and from the chunk in flight", () => {
    const sources = ids("s", 25);
    let state = reduce(loaded(sources), { type: "expandPlanned", sourceIds: sources, upTo: 750 }, { type: "expandConfirmed" });
    const [started, id] = startTopUp(state, sources.slice(0, 10));
    // s3 is in the chunk in flight, s15 is still queued.
    state = reduce(started, { type: "togglePin", id: "s3" }, { type: "togglePin", id: "s15" });
    expect(state.pending?.id).toBe(id);
    expect(state.expand?.queue).not.toContain("s15");
    expect(state.expand?.sourceIds).toHaveLength(23);

    state = explorationReducer(state, {
      type: "topUpLoaded",
      id,
      response: topUpResponse(sources.slice(0, 10).map((source) => sourceResult(source, [`${source}-n`]))),
    });
    const queue = sources.slice(10).filter((source) => source !== "s15");
    expect(state.expand?.queue).toEqual(queue);
    expect(state.expand?.added).toBe(9);
    expect(visibleNodeIds(state).has("s3-n")).toBe(false);
    const { body } = buildTopUpRequest(state, { kind: "topup", mode: CITERS, batch: queue.slice(0, 10) }, (key) => `hash:${key}`);
    expect(body.sources.map((source) => source.source_group_key)).not.toContain("s15");
  });

  it("ends a run once every queued source is unpinned", () => {
    const sources = ["a", "b"];
    let state = explorationReducer(loaded(sources), { type: "expandPlanned", sourceIds: sources, upTo: 60 });
    const [started, id] = startTopUp(state, sources);
    state = explorationReducer(started, { type: "requestFailed", id, kind: "rate_limited", retryAfter: 5, now: 0 });
    expect(state.expand?.phase).toBe("paused");
    state = explorationReducer(state, { type: "togglePin", id: "a" });
    expect(state.expand?.queue).toEqual(["b"]);
    state = explorationReducer(state, { type: "togglePin", id: "b" });
    expect(state.expand).toBeNull();
    expect(state.notice).toBeNull();
  });

  it("stops the run on cancel, on a mode switch and on range navigation", () => {
    const sources = ids("s", 12);
    const planned = explorationReducer(loaded(sources), { type: "expandPlanned", sourceIds: sources, upTo: 360 });
    expect(planned.expand?.phase).toBe("running");
    const [started] = startTopUp(planned, sources.slice(0, 10));

    const cancelled = explorationReducer(started, { type: "expandCancelled" });
    expect(cancelled.expand).toBeNull();
    expect(cancelled.pending).toBeNull();
    expect(cancelled.notice).toEqual({ kind: "partialTopUp", params: { done: 0, total: 12, failed: 0 } });

    expect(explorationReducer(started, { type: "setMode", mode: { order: "recent" } }).expand).toBeNull();
    const [navigating] = startRange(explorationReducer(started, { type: "select", id: "s0" }), "s0");
    expect(navigating.expand).toBeNull();
    expect(navigating.pending?.kind).toBe("range");

    const confirm = explorationReducer(loaded(ids("s", 21)), { type: "expandPlanned", sourceIds: ids("s", 21), upTo: 630 });
    expect(explorationReducer(confirm, { type: "expandCancelled" }).notice).toBeNull();
  });
});

describe("ranking, provider limits and base notices", () => {
  it("keeps a stalled ranking for its source until another request, source or mode", () => {
    const selected = explorationReducer(loaded(["x", "y"]), { type: "select", id: "x" });
    const [started, id] = startRange(selected, "x");
    const stalled = explorationReducer(started, { type: "rankingStalled", id, scanned: 4000, providerTotal: 9000 });
    expect(stalled.pending).toBeNull();
    expect(stalled.rankingStall).toEqual({
      request: { kind: "range", sourceId: "x", mode: CITERS, rangeIndex: 0, last: false },
      scanned: 4000,
      providerTotal: 9000,
    });
    expect(currentBranch(stalled, "x")).toBeUndefined();
    expect(modeSwitchAutoLoad(stalled)).toBe("x");
    // A stale id is ignored.
    expect(explorationReducer(stalled, { type: "rankingStalled", id, scanned: 1, providerTotal: null })).toBe(stalled);

    expect(explorationReducer(stalled, { type: "select", id: "y" }).rankingStall).toBeNull();
    expect(explorationReducer(stalled, { type: "setMode", mode: { order: "recent" } }).rankingStall).toBeNull();
    expect(explorationReducer(stalled, { type: "versionChanged", groupId: "x", canonicalKey: "doi:10.1/x2" }).rankingStall).toBeNull();
    expect(startRange(stalled, "x")[0].rankingStall).toBeNull();
  });

  it("re-queues ranking sources at the end and rate-limited ones at the head, pausing the run", () => {
    const sources = ["a", "b", "c", "d"];
    let state = explorationReducer(loaded(sources), { type: "expandPlanned", sourceIds: sources, upTo: 120 });
    const [started, id] = startTopUp(state, ["a", "b", "c"]);
    state = explorationReducer(started, {
      type: "topUpLoaded",
      id,
      now: 1000,
      response: topUpResponse([
        sourceResult("a", [], { error: "ranking" }),
        sourceResult("b", [], { error: "rate_limited" }),
        sourceResult("c", ["c1"]),
      ]),
    });
    expect(state.expand).toMatchObject({
      phase: "paused",
      queue: ["b", "d", "a"],
      failed: [],
      rankingRounds: { a: 1 },
      retryAfter: 30,
      resumeAt: 31000,
    });
    expect(visibleNodeIds(state).has("c1")).toBe(true);
  });

  it("fails top-up errors outside a run, including ranking", () => {
    const [started, id] = startTopUp(loaded(["x", "y"]), ["x", "y"]);
    const state = explorationReducer(started, {
      type: "topUpLoaded",
      id,
      response: topUpResponse([sourceResult("x", ["a"]), sourceResult("y", [], { error: "ranking" })]),
    });
    expect(state.notice).toEqual({ kind: "partialTopUp", params: { done: 1, total: 2, failed: 1 } });
  });

  it("notes partial base edges until dismissed, across range loads and mode switches", () => {
    let state = explorationReducer(initialExplorationState(), {
      type: "baseLoaded",
      base: baseGraph(["x"], [], [], { edges_partial: true }),
    });
    expect(state.notice).toEqual({ kind: "edgesPartial" });
    state = loadRange(explorationReducer(state, { type: "select", id: "x" }), "x", ["a"]);
    expect(state.notice).toEqual({ kind: "edgesPartial" });
    state = explorationReducer(state, { type: "setMode", mode: { direction: "cites" } });
    expect(state.notice).toEqual({ kind: "edgesPartial" });
    // A range notice replaces it.
    expect(loadRange(state, "x", [], { provider_total: 0, total_available: 0 }).notice?.kind).toBe("empty");
    expect(explorationReducer(state, { type: "dismissNotice" }).notice).toBeNull();
    expect(loaded(["x"]).notice).toBeNull();
  });
});
