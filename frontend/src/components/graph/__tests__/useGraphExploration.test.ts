import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { graph as graphApi } from "@/lib/api";
import { GraphCatalog } from "@/components/graph/graphCatalog";
import { branchKey, currentBranch, visibleNodeIds } from "@/components/graph/graphExploration";
import { useGraphExploration } from "@/components/graph/useGraphExploration";
import type {
  GraphNode,
  GraphResponse,
  PaperMetadata,
  RelatedRangeRequest,
  RelatedRangeResponse,
  TopUpRequest,
  TopUpResponse,
  TopUpSourceResult,
} from "@/types";

vi.mock("@/lib/api", () => ({
  graph: { related: vi.fn(), topUp: vi.fn() },
}));

const related = vi.mocked(graphApi.related);
const topUp = vi.mocked(graphApi.topUp);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function node(id: string, isSeed = false): GraphNode {
  const version = {
    canonical_key: `doi:10.1/${id}`,
    paper_group_key: id,
    title: id,
    authors: [],
    provider_source: "openalex",
  } as unknown as PaperMetadata;
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

function base(seeds: string[]): GraphResponse {
  return {
    active_paper_key: `doi:10.1/${seeds[0]}`,
    active_paper_group_key: seeds[0]!,
    nodes: seeds.map((id) => node(id, true)),
    edges: [],
  };
}

function rangeFor(body: RelatedRangeRequest, keys: string[], extra: Partial<RelatedRangeResponse> = {}): RelatedRangeResponse {
  return {
    source_key: body.source_key,
    source_group_key: body.source_group_key,
    direction: body.direction,
    order: body.order,
    nodes: keys.map((id) => node(id)),
    edges: keys.map((id) => ({ source: id, target: body.source_group_key, relation_type: "cited_by" })),
    group_keys: keys,
    range_start: body.range_start,
    range_end: body.range_start + keys.length,
    range_size: 30,
    max_results: 10000,
    total_available: 1000,
    total_exact: true,
    total_capped: false,
    provider_total: 1000,
    scanned: 1000,
    has_more: true,
    exhausted: false,
    clamped: false,
    scan_incomplete: false,
    snapshot_id: "snap",
    reason: null,
    ...extra,
  };
}

function topUpFor(body: TopUpRequest): TopUpResponse {
  const sources = body.sources.map((source) => ({
    source_key: source.source_key,
    source_group_key: source.source_group_key,
    added_group_keys: [`${source.source_group_key}-n`],
    connected_count: 1,
    total_available: 1,
    total_exact: true,
    total_capped: false,
    provider_total: 1,
    exhausted: true,
    reason: null,
    error: null,
  }));
  return {
    nodes: sources.map((source) => node(source.added_group_keys[0]!)),
    edges: sources.map((source) => ({ source: source.added_group_keys[0]!, target: source.source_group_key, relation_type: "cited_by" })),
    sources,
    range_size: 30,
    max_results: 10000,
  };
}

/** A top-up answer where the listed sources report `error` and add nothing. */
function topUpWith(body: TopUpRequest, errors: Record<string, TopUpSourceResult["error"]>): TopUpResponse {
  const response = topUpFor(body);
  const sources = response.sources.map((source) =>
    errors[source.source_group_key] ? { ...source, added_group_keys: [], error: errors[source.source_group_key]! } : source,
  );
  const kept = new Set(sources.flatMap((source) => source.added_group_keys));
  return {
    ...response,
    sources,
    nodes: response.nodes.filter((item) => kept.has(item.id)),
    edges: response.edges.filter((edge) => kept.has(String(edge.source))),
  };
}

function httpError(status: number, headers: Record<string, string> = {}, data: unknown = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, headers, data } });
}

function ranking(body: RelatedRangeRequest, scanned: number): RelatedRangeResponse {
  return rangeFor(body, [], { scan_incomplete: true, reason: "ranking", scanned, provider_total: 5000, total_available: 0 });
}

/** Queue deferred responses for related() and capture each call. */
function queueRelated() {
  const calls: { body: RelatedRangeRequest; signal?: AbortSignal; reply: Deferred<RelatedRangeResponse> }[] = [];
  related.mockImplementation((body, options) => {
    const reply = deferred<RelatedRangeResponse>();
    calls.push({ body, signal: options?.signal, reply });
    return reply.promise;
  });
  return calls;
}

function queueTopUp() {
  const calls: { body: TopUpRequest; signal?: AbortSignal; reply: Deferred<TopUpResponse> }[] = [];
  topUp.mockImplementation((body, options) => {
    const reply = deferred<TopUpResponse>();
    calls.push({ body, signal: options?.signal, reply });
    return reply.promise;
  });
  return calls;
}

function setup(seeds: string[] = ["s"]) {
  const catalog = new GraphCatalog();
  const graphBase = base(seeds);
  const hook = renderHook(() => useGraphExploration(graphBase, catalog));
  return { ...hook, catalog };
}

beforeEach(() => {
  related.mockReset();
  topUp.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useGraphExploration", () => {
  it("loads the base with seeds pinned, and never fetches on select or pin toggles", () => {
    const { result } = setup(["s", "t"]);
    expect([...result.current.state.pinned]).toEqual(["s", "t"]);
    act(() => result.current.select("s"));
    for (let i = 0; i < 5; i++) act(() => result.current.togglePin("t"));
    act(() => result.current.select(null));
    expect(related).not.toHaveBeenCalled();
    expect(topUp).not.toHaveBeenCalled();
    expect(result.current.state.pinned.has("t")).toBe(false);
  });

  it("loads the first range of the selected source and records the members", async () => {
    const calls = queueRelated();
    const { result, catalog } = setup(["s", "p"]);
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 0 }));
    expect(calls[0]!.body).toEqual({
      source_key: "doi:10.1/s",
      source_group_key: "s",
      direction: "cited_by",
      order: "cited_by_count",
      range_start: 0,
      last: false,
      exclude_group_keys: ["p"],
    });
    expect(result.current.state.pending?.kind).toBe("range");

    await act(async () => calls[0]!.reply.resolve(rangeFor(calls[0]!.body, ["a", "b"])));
    expect(currentBranch(result.current.state, "s")!.memberIds).toEqual(["a", "b"]);
    expect(result.current.state.pending).toBeNull();
    expect(catalog.getNode("a")).toBeDefined();
    expect(result.current.catalogRevision).toBeGreaterThan(0);
  });

  it("aborts a superseded request and ignores its late response", async () => {
    const calls = queueRelated();
    const { result } = setup();
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 0 }));
    act(() => result.current.loadRange({ index: 1 }));
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[1]!.signal?.aborted).toBe(false);
    expect(calls[1]!.body.range_start).toBe(30);

    await act(async () => calls[1]!.reply.resolve(rangeFor(calls[1]!.body, ["b1"])));
    await act(async () => calls[0]!.reply.resolve(rangeFor(calls[0]!.body, ["a1"])));
    expect(currentBranch(result.current.state, "s")!.memberIds).toEqual(["b1"]);
    expect(visibleNodeIds(result.current.state).has("a1")).toBe(false);
  });

  it("drops a pending range when another node is selected", async () => {
    const calls = queueRelated();
    const { result } = setup(["s", "t"]);
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 0 }));
    act(() => result.current.select("t"));
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(result.current.state.pending).toBeNull();
    await act(async () => calls[0]!.reply.resolve(rangeFor(calls[0]!.body, ["a"])));
    expect(currentBranch(result.current.state, "s")).toBeUndefined();
  });

  it("reloads 1–30 under the new mode and ignores the old mode's late response", async () => {
    const calls = queueRelated();
    const { result } = setup();
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 0 }));
    act(() => result.current.setOrder("recent"));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[1]!.body).toMatchObject({ order: "recent", range_start: 0 });

    await act(async () => calls[0]!.reply.resolve(rangeFor(calls[0]!.body, ["old"])));
    await act(async () => calls[1]!.reply.resolve(rangeFor(calls[1]!.body, ["new"])));
    const state = result.current.state;
    expect(currentBranch(state, "s")!.memberIds).toEqual(["new"]);
    expect(state.branches[branchKey("s", "cited_by", "cited_by_count")]).toBeUndefined();

    act(() => result.current.setDirection("cites"));
    expect(calls[2]!.body).toMatchObject({ direction: "cites", order: "recent", range_start: 0 });
    await act(async () => calls[2]!.reply.resolve(rangeFor(calls[2]!.body, ["ref"])));
    const retired = result.current.state.branches[branchKey("s", "cited_by", "recent")]!;
    expect(retired.active).toBe(false);
    expect(visibleNodeIds(result.current.state).has("new")).toBe(false);
  });

  it("applies only the last response across rapid A→B→A switches and keeps pins", async () => {
    const calls = queueRelated();
    const { result } = setup();
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 0 }));
    await act(async () => calls[0]!.reply.resolve(rangeFor(calls[0]!.body, ["a", "k"])));
    act(() => result.current.togglePin("k"));

    act(() => result.current.setOrder("recent"));
    act(() => result.current.setOrder("cited_by_count"));
    expect(calls).toHaveLength(3);
    expect(calls[1]!.signal?.aborted).toBe(true);
    expect(calls[2]!.body).toMatchObject({ order: "cited_by_count", range_start: 0, exclude_group_keys: ["k"] });

    // The late responses arrive in reverse order.
    await act(async () => calls[2]!.reply.resolve(rangeFor(calls[2]!.body, ["a2"])));
    await act(async () => calls[1]!.reply.resolve(rangeFor(calls[1]!.body, ["b1"])));
    const state = result.current.state;
    expect(currentBranch(state, "s")!.memberIds).toEqual(["a2", "k"]);
    expect(state.branches[branchKey("s", "cited_by", "recent")]).toBeUndefined();
    expect(state.pinned.has("k")).toBe(true);
    const visible = visibleNodeIds(state);
    expect(visible.has("k")).toBe(true);
    expect(visible.has("a")).toBe(false);
    expect(visible.has("b1")).toBe(false);
  });

  it("maps failures to error kinds and retries the same logical request", async () => {
    const calls = queueRelated();
    const { result } = setup(["s", "p"]);
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 2 }));

    await act(async () => calls[0]!.reply.reject(httpError(429, { "retry-after": "12" })));
    expect(result.current.state.error).toMatchObject({ kind: "rate_limited", retryAfter: 12 });

    act(() => result.current.retry());
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    await act(async () => calls[1]!.reply.reject(httpError(502)));
    expect(result.current.state.error?.kind).toBe("provider");

    act(() => result.current.retry());
    await act(async () => calls[2]!.reply.reject(new Error("Network Error")));
    expect(result.current.state.error?.kind).toBe("network");

    act(() => result.current.retry());
    await act(async () => calls[3]!.reply.reject(httpError(500)));
    expect(result.current.state.error?.kind).toBe("server");

    // Pins changed since: the retried body carries the new exclusions.
    act(() => result.current.togglePin("q"));
    act(() => result.current.retry());
    expect(calls[4]!.body).toEqual({ ...calls[0]!.body, exclude_group_keys: ["p", "q"] });
    await act(async () => calls[4]!.reply.resolve(rangeFor(calls[4]!.body, ["r"], { range_start: 60 })));
    expect(result.current.state.error).toBeNull();
    expect(currentBranch(result.current.state, "s")!.rangeIndex).toBe(2);
  });

  it("continues an incomplete scan at most three times", async () => {
    const calls = queueRelated();
    const { result } = setup();
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ last: true }));
    for (let i = 0; i < 3; i++) {
      await act(async () =>
        calls[i]!.reply.resolve(rangeFor(calls[i]!.body, ["x"], { scan_incomplete: true, scanned: (i + 1) * 200 })),
      );
      expect(calls).toHaveLength(i + 2);
      expect(calls[i + 1]!.body).toMatchObject({ last: true });
      expect(result.current.state.pending).toMatchObject({ autoContinue: i + 1, scanned: (i + 1) * 200 });
    }
    await act(async () => calls[3]!.reply.resolve(rangeFor(calls[3]!.body, ["x"], { scan_incomplete: true })));
    expect(calls).toHaveLength(4);
    expect(result.current.state.pending).toBeNull();
    expect(currentBranch(result.current.state, "s")!.memberIds).toEqual(["x"]);
  });

  it("double-click selects and loads 1–30 only when the branch is not loaded", async () => {
    const calls = queueRelated();
    const { result } = setup();
    act(() => result.current.loadFirstRangeFor("s"));
    expect(result.current.state.selectedId).toBe("s");
    act(() => result.current.loadFirstRangeFor("s"));
    expect(calls).toHaveLength(1);
    await act(async () => calls[0]!.reply.resolve(rangeFor(calls[0]!.body, ["a"])));
    act(() => result.current.loadFirstRangeFor("s"));
    expect(calls).toHaveLength(1);
  });

  it("expands every deficient pinned source in sequential chunks of 10 after confirmation", async () => {
    const calls = queueTopUp();
    const seeds = Array.from({ length: 25 }, (_, i) => `s${i}`);
    const { result } = setup(seeds);
    act(() => result.current.expandPinned());
    expect(result.current.state.expand).toMatchObject({ phase: "confirm", upTo: 750 });
    expect(topUp).not.toHaveBeenCalled();

    act(() => result.current.confirmExpand());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.sources.map((source) => source.source_group_key)).toEqual(seeds.slice(0, 10));
    expect(calls[0]!.body.target_per_source).toBe(30);

    await act(async () => calls[0]!.reply.resolve(topUpFor(calls[0]!.body)));
    expect(calls).toHaveLength(2);
    expect(result.current.state.expand?.queue).toHaveLength(15);
    await act(async () => calls[1]!.reply.resolve(topUpFor(calls[1]!.body)));
    expect(calls[2]!.body.sources).toHaveLength(5);
    await act(async () => calls[2]!.reply.resolve(topUpFor(calls[2]!.body)));

    expect(calls).toHaveLength(3);
    expect(result.current.state.expand).toBeNull();
    expect(visibleNodeIds(result.current.state).has("s24-n")).toBe(true);
    act(() => result.current.expandPinned());
    expect(result.current.state.notice?.kind).toBe("nothingToExpand");
  });

  it("does not expand a source unpinned during the run", async () => {
    const calls = queueTopUp();
    const seeds = Array.from({ length: 25 }, (_, i) => `s${i}`);
    const { result } = setup(seeds);
    act(() => result.current.expandPinned());
    act(() => result.current.confirmExpand());
    act(() => result.current.togglePin("s15"));

    await act(async () => calls[0]!.reply.resolve(topUpFor(calls[0]!.body)));
    const second = calls[1]!.body;
    expect(second.sources.map((source) => source.source_group_key)).toEqual([...seeds.slice(10, 15), ...seeds.slice(16, 21)]);
    expect(second.exclude_group_keys).not.toContain("s15");
    expect(result.current.state.expand?.sourceIds).toHaveLength(24);
  });

  it("pauses on 429 and resumes by itself after Retry-After", async () => {
    vi.useFakeTimers();
    const calls = queueTopUp();
    const { result } = setup(["a", "b"]);
    act(() => result.current.expandPinned());
    expect(calls).toHaveLength(1);

    await act(async () => calls[0]!.reply.reject(httpError(429, { "retry-after": "3" })));
    expect(result.current.state.expand).toMatchObject({ phase: "paused", retryAfter: 3 });
    await act(async () => {
      vi.advanceTimersByTime(2900);
    });
    expect(calls).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.sources.map((source) => source.source_group_key)).toEqual(["a", "b"]);
    await act(async () => calls[1]!.reply.resolve(topUpFor(calls[1]!.body)));
    expect(result.current.state.expand).toBeNull();
  });

  it("cancels an expansion and aborts its request", async () => {
    const calls = queueTopUp();
    const { result } = setup(["a", "b"]);
    act(() => result.current.expandPinned());
    act(() => result.current.cancelExpand());
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(result.current.state.expand).toBeNull();
    await act(async () => calls[0]!.reply.resolve(topUpFor(calls[0]!.body)));
    expect(visibleNodeIds(result.current.state).has("a-n")).toBe(false);
  });

  it("aborts the in-flight request on unmount", () => {
    const calls = queueRelated();
    const { result, unmount } = setup();
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 0 }));
    unmount();
    expect(calls[0]!.signal?.aborted).toBe(true);
  });
});

describe("useGraphExploration ranking and provider limits", () => {
  it("re-requests a range while the provider list is ranked and the scan advances, up to six times", async () => {
    const calls = queueRelated();
    const { result } = setup();
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 0 }));
    for (let i = 0; i < 6; i++) {
      await act(async () => calls[i]!.reply.resolve(ranking(calls[i]!.body, (i + 1) * 500)));
      expect(calls).toHaveLength(i + 2);
      expect(calls[i + 1]!.body).toEqual(calls[0]!.body);
      expect(result.current.state.pending).toMatchObject({ autoContinue: i + 1, scanned: (i + 1) * 500, ranking: true });
    }
    await act(async () => calls[6]!.reply.resolve(ranking(calls[6]!.body, 3500)));
    expect(calls).toHaveLength(7);
    const state = result.current.state;
    expect(state.pending).toBeNull();
    expect(state.rankingStall).toEqual({ request: expect.objectContaining({ sourceId: "s", rangeIndex: 0 }), scanned: 3500, providerTotal: 5000 });
    // Nothing was applied: the range is still not loaded.
    expect(currentBranch(state, "s")).toBeUndefined();

    act(() => result.current.continueRanking());
    expect(calls).toHaveLength(8);
    expect(calls[7]!.body).toEqual(calls[0]!.body);
    expect(result.current.state.rankingStall).toBeNull();
    expect(result.current.state.pending).toMatchObject({ autoContinue: 0, scanned: 3500, ranking: true });
    await act(async () => calls[7]!.reply.resolve(rangeFor(calls[7]!.body, ["a"])));
    expect(currentBranch(result.current.state, "s")!.memberIds).toEqual(["a"]);
  });

  it("stops at once when the ranking scan does not advance", async () => {
    const calls = queueRelated();
    const { result } = setup();
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 0 }));
    await act(async () => calls[0]!.reply.resolve(ranking(calls[0]!.body, 800)));
    await act(async () => calls[1]!.reply.resolve(ranking(calls[1]!.body, 800)));
    expect(calls).toHaveLength(2);
    expect(result.current.state.rankingStall?.scanned).toBe(800);

    // A mode switch reloads the stalled source under the new mode.
    act(() => result.current.setOrder("recent"));
    expect(calls[2]!.body).toMatchObject({ order: "recent", range_start: 0 });
    expect(result.current.state.rankingStall).toBeNull();
  });

  it("reports ranking progress against what is collected: capped at max_results, never below scanned", async () => {
    const calls = queueRelated();
    const { result } = setup();
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 0 }));
    const capped = { scan_incomplete: true, reason: "ranking" as const, provider_total: 50000, total_available: 10000 };
    await act(async () => calls[0]!.reply.resolve(rangeFor(calls[0]!.body, [], { ...capped, scanned: 1000 })));
    expect(result.current.state.pending).toMatchObject({ scanned: 1000, providerTotal: 10000, ranking: true });
    await act(async () => calls[1]!.reply.resolve(rangeFor(calls[1]!.body, [], { ...capped, scanned: 1000 })));
    expect(result.current.state.rankingStall).toMatchObject({ scanned: 1000, providerTotal: 10000 });

    // The provider's count can trail the records it lists.
    act(() => result.current.continueRanking());
    const short = { scan_incomplete: true, reason: "ranking" as const, provider_total: 900, total_available: 1100 };
    await act(async () => calls[2]!.reply.resolve(rangeFor(calls[2]!.body, [], { ...short, scanned: 1100 })));
    expect(result.current.state.pending).toMatchObject({ scanned: 1100, providerTotal: 1100, ranking: true });
  });

  it("maps a rate-limited provider (503 with Retry-After) to a countdown and keeps the error for its message", async () => {
    const calls = queueRelated();
    const { result } = setup();
    act(() => result.current.select("s"));
    act(() => result.current.loadRange({ index: 0 }));
    const limited = httpError(503, { "retry-after": "20" }, { detail: { code: "related_provider_unavailable", message: "x" } });
    await act(async () => calls[0]!.reply.reject(limited));
    expect(result.current.state.error).toMatchObject({ kind: "rate_limited", retryAfter: 20, cause: limited });

    act(() => result.current.retry());
    const down = httpError(503, {}, { detail: { code: "related_provider_unavailable", message: "x" } });
    await act(async () => calls[1]!.reply.reject(down));
    expect(result.current.state.error).toMatchObject({ kind: "provider", retryAfter: null, cause: down });

    act(() => result.current.retry());
    const coded = httpError(503, {}, { detail: { code: "provider_rate_limited", message: "x", retry_after: 9 } });
    await act(async () => calls[2]!.reply.reject(coded));
    expect(result.current.state.error).toMatchObject({ kind: "rate_limited", retryAfter: 9 });
  });

  it("asks again for top-up sources still being ranked, at most three more rounds", async () => {
    const calls = queueTopUp();
    const { result } = setup(["a", "b", "c"]);
    act(() => result.current.expandPinned());
    await act(async () => calls[0]!.reply.resolve(topUpWith(calls[0]!.body, { b: "ranking" })));
    expect(result.current.state.expand).toMatchObject({ phase: "running", queue: ["b"], rankingRounds: { b: 1 } });
    for (let round = 1; round <= 3; round++) {
      expect(calls[round]!.body.sources.map((source) => source.source_group_key)).toEqual(["b"]);
      await act(async () => calls[round]!.reply.resolve(topUpWith(calls[round]!.body, { b: "ranking" })));
    }
    expect(calls).toHaveLength(4);
    const state = result.current.state;
    expect(state.expand).toBeNull();
    expect(state.notice).toEqual({ kind: "partialTopUp", params: { done: 2, total: 3, failed: 1 } });
    expect(visibleNodeIds(state).has("a-n")).toBe(true);
  });

  it("pauses the run on a rate-limited top-up source and resumes it after the provider wait", async () => {
    vi.useFakeTimers();
    const calls = queueTopUp();
    const { result } = setup(["a", "b"]);
    act(() => result.current.expandPinned());
    await act(async () => calls[0]!.reply.resolve(topUpWith(calls[0]!.body, { a: "rate_limited" })));
    expect(result.current.state.expand).toMatchObject({ phase: "paused", retryAfter: 30, queue: ["a"] });
    expect(visibleNodeIds(result.current.state).has("b-n")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(29_900);
    });
    expect(calls).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.sources.map((source) => source.source_group_key)).toEqual(["a"]);
    await act(async () => calls[1]!.reply.resolve(topUpFor(calls[1]!.body)));
    expect(result.current.state.expand).toBeNull();
    expect(result.current.state.notice).toBeNull();
  });
});
