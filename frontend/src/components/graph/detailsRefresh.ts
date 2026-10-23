import type { GraphCatalog } from "@/components/graph/graphCatalog";
import type { GraphNode } from "@/types";

/** Background re-requests of one response's pending details, at most. */
export const DETAILS_REFRESH_ATTEMPTS = 2;
/** Wait before a re-request when the server suggested none. */
export const DETAILS_REFRESH_DELAY_SECONDS = 3;
/** Responses refreshed at a time: an older one gives its nodes up. */
export const DETAILS_REFRESH_CHAINS = 2;
/** Wait before a refresh that made way for the user's request tries again. */
export const DETAILS_REFRESH_YIELD_SECONDS = 1.5;
/** A longer suggested wait is cut to this: the titles are on screen. */
const MAX_DELAY_SECONDS = 30;

/** What a related range or top-up response tells about its nodes' details. */
export interface DetailsResponse {
  nodes: GraphNode[];
  details_incomplete?: boolean;
  retry_after?: number | null;
}

/** Re-sends the same request (same body) for its node payloads. */
export type Refetch = (signal: AbortSignal) => Promise<DetailsResponse>;

export interface DetailsRefresherOptions {
  /** Reads the retry wait a failed re-request carries, if any. */
  retryAfterOf?: (err: unknown) => number | null;
  /**
   * A failure after which asking again would only spend the user's own
   * request budget (OpenBib's rate limit): the refresh gives up at once.
   */
  stopsOn?: (err: unknown) => boolean;
  /** A request of the user's is in flight (or waits out a rate limit): refreshes wait. */
  isBusy?: () => boolean;
  /** The nodes on the canvas: a refresh whose nodes all left it stops. */
  visibleIds?: () => ReadonlySet<string>;
}

interface Chain {
  key: string;
  ids: Set<string>;
  attempts: number;
  refetch: Refetch;
  timer: number | null;
  controller: AbortController | null;
}

function delayMs(seconds: number | null | undefined): number {
  const value = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : DETAILS_REFRESH_DELAY_SECONDS;
  return Math.min(value, MAX_DELAY_SECONDS) * 1000;
}

/**
 * Completes nodes a range or top-up response served with list data only
 * (`details_pending`): when the server says asking again may help
 * (`details_incomplete`), the same request is re-sent after `retry_after`
 * (or a short default), at most DETAILS_REFRESH_ATTEMPTS times. Only node
 * payloads are merged into the catalog, and only into nodes still pending:
 * the exploration state (ranges, selection, requests in flight) and the view
 * never change. Nodes it gives up on are marked unavailable.
 *
 * Refreshes never compete with the user: one is in flight at a time, never
 * while a request of the user's is (`isBusy`; a new one makes a refresh in
 * flight step aside, see `yieldToForeground`), only for the
 * DETAILS_REFRESH_CHAINS most recent responses, only while some of their
 * nodes are on the canvas, and never again after OpenBib's own rate limit
 * answered one (`stopsOn`). `cancel()` drops everything (a new base graph,
 * leaving the page).
 */
export class DetailsRefresher {
  /** Oldest first. */
  private readonly chains = new Map<string, Chain>();
  /** The one refresh request in flight, if any. */
  private inFlight: Chain | null = null;

  constructor(
    private readonly catalog: GraphCatalog,
    /** The catalog changed: the canvas and lists must pick it up. */
    private readonly changed: () => void,
    private readonly options: DetailsRefresherOptions = {},
  ) {}

  /**
   * A response (already added to the catalog) served pending nodes. `key`
   * identifies its request: a second response to the same request joins
   * the refresh already running for it.
   */
  track(key: string, response: DetailsResponse, refetch: Refetch): void {
    const ids = response.nodes.filter((node) => node.details_pending).map((node) => node.id).filter((id) => this.catalog.hasPendingDetails(id));
    if (ids.length === 0) return;
    if (!response.details_incomplete) {
      // Nothing a new request would fix (the provider has no record).
      this.giveUp(ids);
      return;
    }
    let chain = this.chains.get(key);
    if (chain) {
      for (const id of ids) chain.ids.add(id);
      // The most recent response again.
      this.chains.delete(key);
      this.chains.set(key, chain);
    } else {
      chain = { key, ids: new Set(ids), attempts: 0, refetch, timer: null, controller: null };
      this.chains.set(key, chain);
      this.schedule(chain, response.retry_after);
    }
    if (this.catalog.markDetailsUnavailable(ids, false)) this.changed();
    while (this.chains.size > DETAILS_REFRESH_CHAINS) {
      this.drop(this.chains.values().next().value as Chain);
    }
  }

  /** Whether a refresh is scheduled or in flight (for tests and diagnostics). */
  get active(): number {
    return this.chains.size;
  }

  /**
   * The user started a request: a refresh in flight makes way for it (it is
   * aborted, so the server stops its provider calls, and the attempt is not
   * spent) and tries again once the user's request is done.
   */
  yieldToForeground(): void {
    const chain = this.inFlight;
    if (!chain) return;
    this.stop(chain);
    chain.attempts -= 1;
    this.schedule(chain, DETAILS_REFRESH_YIELD_SECONDS);
  }

  cancel(): void {
    for (const chain of this.chains.values()) this.stop(chain);
    this.chains.clear();
  }

  private schedule(chain: Chain, seconds: number | null | undefined): void {
    chain.timer = window.setTimeout(() => {
      chain.timer = null;
      this.fire(chain);
    }, delayMs(seconds));
  }

  /** Clear the chain's timer and abort its request, if any. */
  private stop(chain: Chain): void {
    if (chain.timer !== null) window.clearTimeout(chain.timer);
    chain.timer = null;
    chain.controller?.abort();
    chain.controller = null;
    if (this.inFlight === chain) this.inFlight = null;
  }

  /** Stop a chain for good: what it still covered is unavailable. */
  private drop(chain: Chain): void {
    this.stop(chain);
    this.chains.delete(chain.key);
    this.giveUp(this.pendingOf(chain));
  }

  private pendingOf(chain: Chain): string[] {
    return [...chain.ids].filter((id) => this.catalog.hasPendingDetails(id));
  }

  private fire(chain: Chain): void {
    if (this.chains.get(chain.key) !== chain) return;
    // Another response, or the details panel, may have completed them.
    const pending = this.pendingOf(chain);
    if (pending.length === 0) {
      this.chains.delete(chain.key);
      return;
    }
    // The user moved on (another range or direction): asking for those
    // nodes again tracks them again.
    const visible = this.options.visibleIds?.();
    if (visible && !pending.some((id) => visible.has(id))) {
      this.drop(chain);
      return;
    }
    // The user's own requests first, and one refresh at a time.
    if (this.options.isBusy?.() || this.inFlight !== null) {
      this.schedule(chain, DETAILS_REFRESH_YIELD_SECONDS);
      return;
    }
    chain.attempts += 1;
    const controller = new AbortController();
    chain.controller = controller;
    this.inFlight = chain;
    const current = () => this.chains.get(chain.key) === chain && chain.controller === controller;
    const settle = () => {
      chain.controller = null;
      this.inFlight = null;
    };
    chain.refetch(controller.signal).then(
      (response) => {
        if (!current()) return;
        settle();
        if (this.catalog.mergeDetails(response.nodes)) this.changed();
        this.next(chain, response.details_incomplete ? response.retry_after : null, !!response.details_incomplete);
      },
      (err: unknown) => {
        if (!current()) return;
        settle();
        const stops = this.options.stopsOn?.(err) ?? false;
        this.next(chain, this.options.retryAfterOf?.(err) ?? null, !stops);
      },
    );
  }

  private next(chain: Chain, retryAfter: number | null | undefined, retryable: boolean): void {
    const pending = this.pendingOf(chain);
    if (pending.length > 0 && retryable && chain.attempts < DETAILS_REFRESH_ATTEMPTS) {
      this.schedule(chain, retryAfter);
      return;
    }
    this.chains.delete(chain.key);
    this.giveUp(pending);
  }

  /** Mark nodes no refresh will complete, unless another refresh covers them. */
  private giveUp(ids: string[]): void {
    const covered = new Set<string>();
    for (const chain of this.chains.values()) for (const id of chain.ids) covered.add(id);
    if (this.catalog.markDetailsUnavailable(ids.filter((id) => !covered.has(id)), true)) this.changed();
  }
}
