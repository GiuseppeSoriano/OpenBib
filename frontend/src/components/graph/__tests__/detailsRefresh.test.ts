import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETAILS_REFRESH_ATTEMPTS,
  DETAILS_REFRESH_CHAINS,
  DetailsRefresher,
  type DetailsRefresherOptions,
  type DetailsResponse,
} from "@/components/graph/detailsRefresh";
import { GraphCatalog } from "@/components/graph/graphCatalog";
import type { GraphNode, PaperMetadata } from "@/types";

function node(id: string, pending: boolean): GraphNode {
  const key = `doi:10.1/${id}`;
  const version = {
    canonical_key: key,
    paper_group_key: id,
    title: pending ? key : `Title of ${id}`,
    authors: [],
    provider_source: "semantic_scholar",
  } as unknown as PaperMetadata;
  return {
    id,
    label: pending ? null : version.title,
    type: "paper",
    paper_group_key: id,
    version_count: 1,
    selected_version: version,
    versions: [version],
    is_seed: false,
    details_pending: pending,
  };
}

const incomplete = (nodes: GraphNode[], retryAfter: number | null = null): DetailsResponse => ({
  nodes,
  details_incomplete: true,
  retry_after: retryAfter,
});

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

function setup(ids: string[], options: DetailsRefresherOptions = {}) {
  const catalog = new GraphCatalog();
  catalog.add({ nodes: ids.map((id) => node(id, true)), edges: [] });
  const changed = vi.fn();
  const refresher = new DetailsRefresher(catalog, changed, options);
  return { catalog, changed, refresher };
}

describe("DetailsRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-sends the request after the default wait and merges only the node payloads", async () => {
    const { catalog, changed, refresher } = setup(["a", "b"]);
    const refetch = vi.fn(async () => ({ nodes: [node("a", false), node("b", false), node("new", false)] }));

    refresher.track("range:1", incomplete([node("a", true), node("b", true)]), refetch);
    await vi.advanceTimersByTimeAsync(2900);
    expect(refetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(catalog.getNode("a")!.selected_version.title).toBe("Title of a");
    expect(catalog.getNode("b")!.selected_version.title).toBe("Title of b");
    expect(catalog.getNode("new")).toBeUndefined();
    expect(changed).toHaveBeenCalled();
    expect(refresher.active).toBe(0);
  });

  it("waits for the server's retry_after", async () => {
    const { refresher } = setup(["a"]);
    const refetch = vi.fn(async () => ({ nodes: [node("a", false)] }));
    refresher.track("range:1", incomplete([node("a", true)], 7), refetch);
    await vi.advanceTimersByTimeAsync(6900);
    expect(refetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after its attempts and marks what is still pending unavailable", async () => {
    const { catalog, refresher } = setup(["a", "b"]);
    let call = 0;
    const refetch = vi.fn(async () => {
      call += 1;
      // The first re-request completes "a" only; "b" never comes.
      return incomplete(call === 1 ? [node("a", false), node("b", true)] : [node("b", true)]);
    });

    refresher.track("range:1", incomplete([node("a", true), node("b", true)]), refetch);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refetch).toHaveBeenCalledTimes(DETAILS_REFRESH_ATTEMPTS);
    expect(catalog.getNode("a")!.details_pending).toBeFalsy();
    expect(catalog.getNode("b")!.detailsUnavailable).toBe(true);
    expect(refresher.active).toBe(0);
  });

  it("does not re-request what asking again cannot fix", async () => {
    const { catalog, changed, refresher } = setup(["a"]);
    const refetch = vi.fn();
    refresher.track("range:1", { nodes: [node("a", true)], details_incomplete: false }, refetch);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refetch).not.toHaveBeenCalled();
    expect(catalog.getNode("a")!.detailsUnavailable).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("skips the request when the nodes were completed meanwhile", async () => {
    const { catalog, refresher } = setup(["a"]);
    const refetch = vi.fn();
    refresher.track("range:1", incomplete([node("a", true)]), refetch);
    catalog.add({ nodes: [node("a", false)], edges: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refetch).not.toHaveBeenCalled();
    expect(refresher.active).toBe(0);
  });

  it("joins a second response to the same request instead of doubling it", async () => {
    const { catalog, refresher } = setup(["a"]);
    catalog.markDetailsUnavailable(["a"], true);
    const refetch = vi.fn(async () => ({ nodes: [node("a", false)] }));
    refresher.track("range:1", incomplete([node("a", true)]), refetch);
    // A new refresh brings the node back to "loading".
    expect(catalog.getNode("a")!.detailsUnavailable).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    refresher.track("range:1", incomplete([node("a", true)]), refetch);
    expect(refresher.active).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("retries a failed re-request, then gives up", async () => {
    const { catalog, refresher } = setup(["a"]);
    const refetch = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    refresher.track("range:1", incomplete([node("a", true)]), refetch);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refetch).toHaveBeenCalledTimes(DETAILS_REFRESH_ATTEMPTS);
    expect(catalog.getNode("a")!.detailsUnavailable).toBe(true);
  });

  it("cancel() aborts a re-request in flight and ignores its late answer", async () => {
    const { catalog, changed, refresher } = setup(["a", "b"]);
    const answer = deferred<DetailsResponse>();
    let signal: AbortSignal | null = null;
    refresher.track("range:1", incomplete([node("a", true)]), (s) => {
      signal = s;
      return answer.promise;
    });
    const later = vi.fn();
    refresher.track("topup:1", incomplete([node("b", true)], 20), later);
    await vi.advanceTimersByTimeAsync(3000);
    expect(signal).not.toBeNull();
    changed.mockClear();

    refresher.cancel();
    expect(signal!.aborted).toBe(true);
    answer.resolve({ nodes: [node("a", false)] });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(later).not.toHaveBeenCalled();
    expect(catalog.getNode("a")!.details_pending).toBe(true);
    expect(catalog.getNode("a")!.detailsUnavailable).toBeFalsy();
    expect(changed).not.toHaveBeenCalled();
    expect(refresher.active).toBe(0);
  });

  it("never marks a node another refresh still covers", async () => {
    const { catalog, refresher } = setup(["a"]);
    const quick = vi.fn(async () => incomplete([node("a", true)]));
    const slow = vi.fn(async () => ({ nodes: [node("a", false)] }));
    refresher.track("range:1", incomplete([node("a", true)]), quick);
    refresher.track("topup:1", incomplete([node("a", true)], 25), slow);
    await vi.advanceTimersByTimeAsync(10_000);
    // The range refresh gave up, but the top-up's is still due.
    expect(quick).toHaveBeenCalledTimes(DETAILS_REFRESH_ATTEMPTS);
    expect(catalog.getNode("a")!.detailsUnavailable).toBeFalsy();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(catalog.getNode("a")!.selected_version.title).toBe("Title of a");
  });

  it("waits while a request of the user's is in flight, without spending an attempt", async () => {
    let busy = true;
    const { catalog, refresher } = setup(["a"], { isBusy: () => busy });
    const refetch = vi.fn(async () => incomplete([node("a", true)]));
    refresher.track("range:1", incomplete([node("a", true)]), refetch);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refetch).not.toHaveBeenCalled();
    expect(catalog.getNode("a")!.detailsUnavailable).toBeFalsy();

    busy = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(refetch).toHaveBeenCalledTimes(1);
    // Waiting cost nothing: the second attempt still comes.
    await vi.advanceTimersByTimeAsync(3000);
    expect(refetch).toHaveBeenCalledTimes(DETAILS_REFRESH_ATTEMPTS);
  });

  it("sends one refresh at a time", async () => {
    const { refresher } = setup(["a", "b"]);
    const answer = deferred<DetailsResponse>();
    const first = vi.fn(() => answer.promise);
    const second = vi.fn(async () => ({ nodes: [node("b", false)] }));
    refresher.track("range:1", incomplete([node("a", true)]), first);
    refresher.track("range:2", incomplete([node("b", true)]), second);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    answer.resolve({ nodes: [node("a", false)] });
    await vi.advanceTimersByTimeAsync(1500);
    expect(second).toHaveBeenCalledTimes(1);
    expect(refresher.active).toBe(0);
  });

  it("makes way for the user's request: aborted, its late answer ignored, its attempt kept", async () => {
    const { catalog, refresher } = setup(["a"]);
    const signals: AbortSignal[] = [];
    const answers: Deferred<DetailsResponse>[] = [];
    const refetch = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      answers.push(deferred<DetailsResponse>());
      return answers[answers.length - 1]!.promise;
    });
    refresher.track("range:1", incomplete([node("a", true)]), refetch);
    await vi.advanceTimersByTimeAsync(3000);
    expect(refetch).toHaveBeenCalledTimes(1);

    refresher.yieldToForeground();
    expect(signals[0]!.aborted).toBe(true);
    answers[0]!.resolve({ nodes: [node("a", false)] });
    await vi.advanceTimersByTimeAsync(0);
    expect(catalog.getNode("a")!.details_pending).toBe(true);

    // It tries again shortly after, with both attempts still to spend.
    await vi.advanceTimersByTimeAsync(1500);
    expect(refetch).toHaveBeenCalledTimes(2);
    answers[1]!.resolve(incomplete([node("a", true)]));
    await vi.advanceTimersByTimeAsync(3000);
    expect(refetch).toHaveBeenCalledTimes(3);
    answers[2]!.resolve({ nodes: [node("a", false)] });
    await vi.advanceTimersByTimeAsync(0);
    expect(catalog.getNode("a")!.selected_version.title).toBe("Title of a");
    expect(refresher.active).toBe(0);
    // Nothing in flight: making way again is a no-op.
    refresher.yieldToForeground();
    expect(refresher.active).toBe(0);
  });

  it(`refreshes the ${DETAILS_REFRESH_CHAINS} most recent responses only`, async () => {
    const { catalog, changed, refresher } = setup(["a", "b", "c"]);
    const refetches = ["a", "b", "c"].map((id) => vi.fn(async () => ({ nodes: [node(id, false)] })));
    refresher.track("range:a", incomplete([node("a", true)]), refetches[0]!);
    refresher.track("range:b", incomplete([node("b", true)]), refetches[1]!);
    changed.mockClear();
    refresher.track("range:c", incomplete([node("c", true)]), refetches[2]!);

    // The oldest gives its nodes up at once ("View details" still works).
    expect(refresher.active).toBe(DETAILS_REFRESH_CHAINS);
    expect(catalog.getNode("a")!.detailsUnavailable).toBe(true);
    expect(changed).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refetches[0]).not.toHaveBeenCalled();
    expect(catalog.getNode("b")!.details_pending).toBeFalsy();
    expect(catalog.getNode("c")!.details_pending).toBeFalsy();
  });

  it("joining a response makes it the most recent again", async () => {
    const { catalog, refresher } = setup(["a", "b", "c"]);
    const refetch = vi.fn(async () => ({ nodes: [node("a", false)] }));
    refresher.track("range:a", incomplete([node("a", true)]), refetch);
    refresher.track("range:b", incomplete([node("b", true)]), vi.fn(async () => ({ nodes: [node("b", false)] })));
    refresher.track("range:a", incomplete([node("a", true)]), refetch);
    refresher.track("range:c", incomplete([node("c", true)]), vi.fn(async () => ({ nodes: [node("c", false)] })));
    expect(catalog.getNode("b")!.detailsUnavailable).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("stops when none of its nodes is on the canvas any more", async () => {
    let visible = new Set(["a"]);
    const { catalog, refresher } = setup(["a"], { visibleIds: () => visible });
    const refetch = vi.fn(async () => incomplete([node("a", true)]));
    refresher.track("range:1", incomplete([node("a", true)]), refetch);
    await vi.advanceTimersByTimeAsync(3000);
    expect(refetch).toHaveBeenCalledTimes(1);

    // The user paged on: the range's nodes left the canvas.
    visible = new Set(["b"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(catalog.getNode("a")!.detailsUnavailable).toBe(true);
    expect(refresher.active).toBe(0);
  });

  it("gives up at once when OpenBib's own rate limit answers", async () => {
    const limited = Object.assign(new Error("HTTP 429"), { status: 429 });
    const { catalog, refresher } = setup(["a"], {
      stopsOn: (err) => err === limited,
      retryAfterOf: () => 2,
    });
    const refetch = vi.fn(async () => {
      throw limited;
    });
    refresher.track("range:1", incomplete([node("a", true)]), refetch);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(catalog.getNode("a")!.detailsUnavailable).toBe(true);
  });
});
