import { linkKey } from "@/components/graph/mergeGraph";
import type {
  CitingOrder,
  GraphEdge,
  GraphResponse,
  RelatedRangeRequest,
  RelatedRangeResponse,
  RelationDirection,
  TopUpRequest,
  TopUpResponse,
} from "@/types";

/**
 * Exploration state of the citation graph — a pure reducer with no React or
 * d3 in it.
 *
 * Membership is tracked per branch, keyed by (source, direction, order), so
 * loading a range replaces only one source's unpinned results: pins, other
 * sources' branches and nodes shared with them stay on the canvas. Pinning
 * changes only the pin set; the eligible list is repartitioned on the next
 * navigation of a branch ("deferred repartition").
 */

export const DEFAULT_RANGE_SIZE = 30;
export const DEFAULT_MAX_RESULTS = 10000;
/** Server cap on `exclude_group_keys`; above it the most recent pins are sent. */
export const MAX_EXCLUSIONS = 500;
/** Sources per top-up request (the server accepts up to 20). */
export const TOPUP_CHUNK = 10;
/** Server cap on `connected_group_keys` per top-up source. */
export const MAX_CONNECTED = 60;
/** Expanding more deficient pinned sources than this asks for confirmation. */
export const TOPUP_CONFIRM_ABOVE = 20;
/** A `scan_incomplete` range is re-requested at most this many times. */
export const MAX_AUTO_CONTINUE = 3;
/** Used when a 429 carries no usable Retry-After (limits are per minute). */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

export interface Mode {
  direction: RelationDirection;
  order: CitingOrder;
}

export type BranchKey = string;

/** JSON keeps the key unambiguous: group keys may contain ':' and '|'. */
export const branchKey = (sourceId: string, direction: RelationDirection, order: CitingOrder): BranchKey =>
  JSON.stringify([sourceId, direction, order]);

export interface BranchMeta {
  key: BranchKey;
  sourceId: string;
  /** Canonical key the branch was loaded with (the source's selected version). */
  sourceKey: string;
  direction: RelationDirection;
  order: CitingOrder;
  /** false once retired: only members that were pinned at retirement remain. */
  active: boolean;
  /** 0-based range shown; null when only topped up, or retired. */
  rangeIndex: number | null;
  /** Served range [rangeStart, rangeEnd); null when not range-navigated. */
  rangeStart: number | null;
  rangeEnd: number | null;
  /** Exactly this branch's members on the canvas, served order first. */
  memberIds: string[];
  edgeKeys: string[];
  rangeSize: number;
  maxResults: number;
  totalAvailable: number | null;
  totalExact: boolean;
  totalCapped: boolean;
  providerTotal: number | null;
  scanned: number;
  hasMore: boolean;
  exhausted: boolean;
  /** `unpinEpoch` when `exhausted` was computed; any later unpin invalidates it. */
  exhaustedUnpinEpoch: number;
  /** `pinEpoch` the current range was computed with (drives the pinsChanged hint). */
  loadedPinEpoch: number;
  reason: "no_provider_id" | null;
  snapshotId: string | null;
}

export interface RangeRequestSpec {
  kind: "range";
  sourceId: string;
  mode: Mode;
  /** null for a `last: true` request, whose index the server decides. */
  rangeIndex: number | null;
  last: boolean;
  /**
   * Set by the mode-switch auto-load (decision 2): on arrival the source's
   * other branches keep only their pinned members.
   */
  retireOtherModes?: boolean;
}

export interface TopUpRequestSpec {
  kind: "topup";
  mode: Mode;
  /** Source group keys taken from the expand queue for this request. */
  batch: string[];
}

export type RequestSpec = RangeRequestSpec | TopUpRequestSpec;

interface RequestStamp {
  id: number;
  pinEpoch: number;
  unpinEpoch: number;
}

export type PendingRange = RangeRequestSpec &
  RequestStamp & {
    sourceKey: string;
    /** Number of automatic re-requests made after `scan_incomplete`. */
    autoContinue: number;
    /** Scan progress from the previous incomplete response, if any. */
    scanned: number | null;
    providerTotal: number | null;
  };

export type PendingTopUp = TopUpRequestSpec & RequestStamp;

export type PendingRequest = PendingRange | PendingTopUp;

export type ErrorKind = "rate_limited" | "provider" | "network" | "server";

export interface ExplorationError {
  request: RequestSpec;
  kind: ErrorKind;
  /** Seconds, for `rate_limited`. */
  retryAfter: number | null;
  /** Epoch ms after which a retry is allowed, for `rate_limited`. */
  retryAt: number | null;
}

export type NoticeKind =
  | "rangeAdjusted"
  | "empty"
  | "allPinned"
  | "noProviderId"
  | "nothingToExpand"
  | "partialTopUp";

export interface Notice {
  kind: NoticeKind;
  params?: Record<string, number | string>;
}

const RANGE_NOTICES: ReadonlySet<NoticeKind> = new Set(["rangeAdjusted", "empty", "allPinned", "noProviderId"]);

/**
 * "Expand pinned nodes": every deficient pinned source of one click, sent in
 * sequential requests of TOPUP_CHUNK sources.
 *
 * - `confirm`: more than TOPUP_CONFIRM_ABOVE sources, waiting for the user.
 * - `running`: a chunk is in flight, or the next one is about to be sent.
 * - `paused`: rate limited; resumes automatically at `resumeAt`.
 * - `failed`: a chunk failed; Retry resumes, Cancel stops.
 */
export interface ExpandRun {
  phase: "confirm" | "running" | "paused" | "failed";
  mode: Mode;
  sourceIds: string[];
  /** Sources not processed yet (the head chunk is re-sent after a pause). */
  queue: string[];
  failed: string[];
  added: number;
  /** Upper bound of new papers, for the confirmation text. */
  upTo: number;
  retryAfter: number | null;
  resumeAt: number | null;
}

export interface ExplorationState {
  mode: Mode;
  selectedId: string | null;
  pinned: ReadonlySet<string>;
  /** Pin order, oldest first; the exclusion cap keeps the most recent pins. */
  pinOrder: string[];
  pinEpoch: number;
  unpinEpoch: number;
  baseIds: ReadonlySet<string>;
  baseEdgeKeys: ReadonlySet<string>;
  /** Endpoints of every edge seen, so edge sets can follow member changes. */
  edgeEnds: Readonly<Record<string, readonly [string, string]>>;
  branches: Readonly<Record<BranchKey, BranchMeta>>;
  /**
   * The source's primary active branch: the one last range-loaded, else the
   * last topped up. Present iff the source has at least one active branch.
   * A range load leaves exactly one active branch for its source; a top-up
   * never retires, so it can leave more than one.
   */
  activeBySource: Readonly<Record<string, BranchKey>>;
  rangeSize: number;
  maxResults: number;
  pending: PendingRequest | null;
  error: ExplorationError | null;
  notice: Notice | null;
  expand: ExpandRun | null;
  /** The last request had more than MAX_EXCLUSIONS pins to exclude. */
  exclusionsCapped: boolean;
  /** Source of the last range load: new nodes spawn around it. */
  anchorId: string | null;
}

export type ExplorationAction =
  | { type: "baseLoaded"; base: GraphResponse }
  | { type: "select"; id: string | null }
  | { type: "setMode"; mode: Partial<Mode> }
  | { type: "togglePin"; id: string }
  | { type: "pinFromDrag"; id: string }
  | { type: "requestStarted"; pending: PendingRequest; exclusionsCapped: boolean }
  | { type: "rangeLoaded"; id: number; response: RelatedRangeResponse }
  | { type: "topUpLoaded"; id: number; response: TopUpResponse }
  | { type: "requestFailed"; id: number; kind: ErrorKind; retryAfter?: number | null; now: number }
  | { type: "versionChanged"; groupId: string; canonicalKey: string }
  | { type: "expandPlanned"; sourceIds: string[]; upTo: number }
  | { type: "expandNothing" }
  | { type: "expandConfirmed" }
  | { type: "expandResumed" }
  | { type: "expandCancelled" }
  | { type: "dismissNotice" }
  | { type: "clearError" };

export function initialExplorationState(
  mode: Mode = { direction: "cited_by", order: "cited_by_count" },
): ExplorationState {
  return {
    mode,
    selectedId: null,
    pinned: new Set(),
    pinOrder: [],
    pinEpoch: 0,
    unpinEpoch: 0,
    baseIds: new Set(),
    baseEdgeKeys: new Set(),
    edgeEnds: {},
    branches: {},
    activeBySource: {},
    rangeSize: DEFAULT_RANGE_SIZE,
    maxResults: DEFAULT_MAX_RESULTS,
    pending: null,
    error: null,
    notice: null,
    expand: null,
    exclusionsCapped: false,
    anchorId: null,
  };
}

/* ── Helpers ──────────────────────────────────────────────── */

function dedupe(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}

export function edgeKey(edge: GraphEdge): string {
  return linkKey(edge);
}

function registerEdges(
  ends: ExplorationState["edgeEnds"],
  edges: GraphEdge[],
): ExplorationState["edgeEnds"] {
  let next: Record<string, readonly [string, string]> | null = null;
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (ends[key] || next?.[key]) continue;
    next = next ?? { ...ends };
    next[key] = [edge.source, edge.target];
  }
  return next ?? ends;
}

/** Keys of `edges` joining `sourceId` to one of `members`. */
function branchEdges(edges: GraphEdge[], sourceId: string, members: ReadonlySet<string>): string[] {
  return edges
    .filter(
      (edge) =>
        (edge.source === sourceId && members.has(edge.target)) ||
        (edge.target === sourceId && members.has(edge.source)),
    )
    .map(edgeKey);
}

function edgesTouching(
  keys: string[],
  ends: ExplorationState["edgeEnds"],
  members: ReadonlySet<string>,
): string[] {
  return keys.filter((key) => {
    const pair = ends[key];
    return !!pair && (members.has(pair[0]) || members.has(pair[1]));
  });
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Drop a branch's unpinned members (and their edges); it no longer navigates. */
function retire(branch: BranchMeta, state: ExplorationState, ends: ExplorationState["edgeEnds"]): BranchMeta {
  const memberIds = branch.memberIds.filter((id) => state.pinned.has(id));
  const edgeKeys = edgesTouching(branch.edgeKeys, ends, new Set(memberIds));
  if (!branch.active && sameIds(memberIds, branch.memberIds) && sameIds(edgeKeys, branch.edgeKeys)) return branch;
  return { ...branch, active: false, rangeIndex: null, rangeStart: null, rangeEnd: null, memberIds, edgeKeys };
}

/** Forget what a branch learned about the source version it was loaded with. */
function forgetVersion(branch: BranchMeta): BranchMeta {
  if (branch.reason === null && !branch.exhausted && branch.snapshotId === null) return branch;
  return { ...branch, reason: null, exhausted: false, snapshotId: null };
}

function specOf(pending: PendingRequest): RequestSpec {
  if (pending.kind === "range") {
    const { sourceId, mode, rangeIndex, last, retireOtherModes } = pending;
    return { kind: "range", sourceId, mode, rangeIndex, last, ...(retireOtherModes ? { retireOtherModes } : {}) };
  }
  return { kind: "topup", mode: pending.mode, batch: pending.batch };
}

function newBranch(sourceId: string, sourceKey: string, mode: Mode, state: ExplorationState): BranchMeta {
  return {
    key: branchKey(sourceId, mode.direction, mode.order),
    sourceId,
    sourceKey,
    direction: mode.direction,
    order: mode.order,
    active: true,
    rangeIndex: null,
    rangeStart: null,
    rangeEnd: null,
    memberIds: [],
    edgeKeys: [],
    rangeSize: state.rangeSize,
    maxResults: state.maxResults,
    totalAvailable: null,
    totalExact: false,
    totalCapped: false,
    providerTotal: null,
    scanned: 0,
    hasMore: true,
    exhausted: false,
    exhaustedUnpinEpoch: state.unpinEpoch,
    loadedPinEpoch: state.pinEpoch,
    reason: null,
    snapshotId: null,
  };
}

/** Close the expand run, leaving a partial notice when it stopped short. */
function finishExpand(state: ExplorationState): ExplorationState {
  const run = state.expand;
  if (!run) return state;
  const total = run.sourceIds.length;
  const processed = total - run.queue.length;
  const failed = run.failed.length;
  const partial = run.phase !== "confirm" && (failed > 0 || run.queue.length > 0);
  return {
    ...state,
    expand: null,
    notice: partial ? { kind: "partialTopUp", params: { done: processed - failed, total, failed } } : state.notice,
  };
}

/* ── Reducer ──────────────────────────────────────────────── */

function applyRange(state: ExplorationState, pending: PendingRange, response: RelatedRangeResponse): ExplorationState {
  const sourceId = pending.sourceId;
  const { direction, order } = pending.mode;
  const key = branchKey(sourceId, direction, order);
  const edgeEnds = registerEdges(state.edgeEnds, response.edges);

  // Defensive: the server excludes pins and the source, but the exclusion
  // list is capped and pins may change while the request is in flight.
  const fresh = dedupe(response.group_keys.filter((id) => id !== sourceId && !state.pinned.has(id)));
  const freshSet = new Set(fresh);
  const prev = state.branches[key];
  const kept = prev ? prev.memberIds.filter((id) => state.pinned.has(id) && !freshSet.has(id)) : [];
  const edgeKeys = dedupe([
    ...branchEdges(response.edges, sourceId, freshSet),
    ...(prev ? edgesTouching(prev.edgeKeys, edgeEnds, new Set(kept)) : []),
  ]);

  // Decision 2: when this load moves the source to another mode (the
  // mode-switch auto-load, or a first range in a new mode), the source's
  // other branches keep only their pinned members. Navigating within a mode
  // replaces only this branch, so topped-up branches survive; retired ones
  // just drop members unpinned since. Other sources are untouched.
  const primary = state.activeBySource[sourceId];
  const switching = !!pending.retireOtherModes || (primary !== undefined && primary !== key);
  const branches: Record<BranchKey, BranchMeta> = { ...state.branches };
  for (const branch of Object.values(state.branches)) {
    if (branch.sourceId !== sourceId || branch.key === key) continue;
    if (switching || !branch.active) branches[branch.key] = retire(branch, state, edgeEnds);
  }
  const rangeSize = response.range_size > 0 ? response.range_size : state.rangeSize;
  branches[key] = {
    ...(prev ?? newBranch(sourceId, pending.sourceKey, pending.mode, state)),
    sourceKey: pending.sourceKey,
    active: true,
    rangeIndex: Math.floor(response.range_start / rangeSize),
    rangeStart: response.range_start,
    rangeEnd: response.range_end,
    memberIds: [...fresh, ...kept],
    edgeKeys,
    rangeSize,
    maxResults: response.max_results,
    totalAvailable: response.total_available,
    totalExact: response.total_exact,
    totalCapped: response.total_capped,
    providerTotal: response.provider_total,
    scanned: response.scanned,
    hasMore: response.has_more,
    exhausted: response.exhausted,
    exhaustedUnpinEpoch: pending.unpinEpoch,
    loadedPinEpoch: pending.pinEpoch,
    reason: response.reason ?? null,
    snapshotId: response.snapshot_id ?? null,
  };

  let notice: Notice | null = null;
  if (response.reason === "no_provider_id") notice = { kind: "noProviderId" };
  else if (fresh.length === 0) {
    const allPinned =
      response.group_keys.length > 0 || ((response.provider_total ?? 0) > 0 && response.total_available === 0);
    notice = allPinned ? { kind: "allPinned" } : { kind: "empty", params: { direction } };
  } else if (response.clamped) {
    notice = {
      kind: "rangeAdjusted",
      params: { total: response.total_available, start: response.range_start + 1, end: response.range_end },
    };
  }

  return {
    ...state,
    branches,
    activeBySource: { ...state.activeBySource, [sourceId]: key },
    edgeEnds,
    rangeSize,
    maxResults: response.max_results,
    pending: null,
    error: null,
    notice,
    anchorId: sourceId,
  };
}

function applyTopUp(state: ExplorationState, pending: PendingTopUp, response: TopUpResponse): ExplorationState {
  const { direction, order } = pending.mode;
  const edgeEnds = registerEdges(state.edgeEnds, response.edges);
  const branches: Record<BranchKey, BranchMeta> = { ...state.branches };
  const activeBySource: Record<string, BranchKey> = { ...state.activeBySource };
  const failed: string[] = [];
  let added = 0;
  // A source unpinned while its chunk was in flight has left the run's queue.
  const queued = state.expand ? new Set(state.expand.queue) : null;

  // Top-up only appends: it never retires a branch (prior branches are kept).
  for (const result of response.sources) {
    const sourceId = result.source_group_key;
    if (queued && !queued.has(sourceId)) continue;
    if (result.error) {
      failed.push(sourceId);
      continue;
    }
    const key = branchKey(sourceId, direction, order);
    const prev = branches[key];
    const existing = prev ? (prev.active ? prev.memberIds : prev.memberIds.filter((id) => state.pinned.has(id))) : [];
    const existingSet = new Set(existing);
    const fresh = dedupe(
      result.added_group_keys.filter((id) => id !== sourceId && !state.pinned.has(id) && !existingSet.has(id)),
    );
    added += fresh.length;
    const prevEdges = prev ? (prev.active ? prev.edgeKeys : edgesTouching(prev.edgeKeys, edgeEnds, existingSet)) : [];
    const base = prev ?? newBranch(sourceId, result.source_key, pending.mode, state);
    branches[key] = {
      ...base,
      sourceKey: prev?.active ? base.sourceKey : result.source_key,
      active: true,
      rangeIndex: prev?.active ? prev.rangeIndex : null,
      rangeStart: prev?.active ? prev.rangeStart : null,
      rangeEnd: prev?.active ? prev.rangeEnd : null,
      memberIds: [...existing, ...fresh],
      edgeKeys: dedupe([...prevEdges, ...branchEdges(response.edges, sourceId, new Set(fresh))]),
      rangeSize: response.range_size > 0 ? response.range_size : base.rangeSize,
      maxResults: response.max_results,
      totalAvailable: result.total_available,
      totalExact: result.total_exact,
      totalCapped: result.total_capped,
      providerTotal: result.provider_total,
      hasMore: !result.exhausted,
      exhausted: result.exhausted,
      exhaustedUnpinEpoch: pending.unpinEpoch,
      reason: result.reason ?? null,
    };
    if (!activeBySource[sourceId]) activeBySource[sourceId] = key;
  }

  let next: ExplorationState = { ...state, branches, activeBySource, edgeEnds, pending: null };
  const run = state.expand;
  if (run) {
    const batch = new Set(pending.batch);
    const updated: ExpandRun = {
      ...run,
      phase: "running",
      queue: run.queue.filter((id) => !batch.has(id)),
      failed: dedupe([...run.failed, ...failed]),
      added: run.added + added,
    };
    next = { ...next, expand: updated };
    if (updated.queue.length === 0) next = finishExpand(next);
  } else if (failed.length > 0) {
    const total = response.sources.length;
    next = { ...next, notice: { kind: "partialTopUp", params: { done: total - failed.length, total, failed: failed.length } } };
  }
  return next;
}

export function explorationReducer(state: ExplorationState, action: ExplorationAction): ExplorationState {
  switch (action.type) {
    case "baseLoaded": {
      const { base } = action;
      const seeds = base.nodes.filter((node) => node.is_seed).map((node) => node.id);
      return {
        ...initialExplorationState(state.mode),
        pinned: new Set(seeds),
        pinOrder: dedupe(seeds),
        baseIds: new Set(base.nodes.map((node) => node.id)),
        baseEdgeKeys: new Set(base.edges.map(edgeKey)),
        edgeEnds: registerEdges({}, base.edges),
        rangeSize: base.related_range_size ?? DEFAULT_RANGE_SIZE,
        maxResults: base.related_max_results ?? DEFAULT_MAX_RESULTS,
      };
    }

    case "select": {
      // Decision 1: selecting never fetches, pins or removes anything.
      if (action.id === state.selectedId) return state;
      const pending = state.pending?.kind === "range" && state.pending.sourceId !== action.id ? null : state.pending;
      const error =
        state.error?.request.kind === "range" && state.error.request.sourceId !== action.id ? null : state.error;
      const notice = state.notice && RANGE_NOTICES.has(state.notice.kind) ? null : state.notice;
      return { ...state, selectedId: action.id, pending, error, notice };
    }

    case "setMode": {
      const mode = { ...state.mode, ...action.mode };
      if (mode.direction === state.mode.direction && mode.order === state.mode.order) return state;
      // Any in-flight request belongs to the old mode; so does an expand run.
      return finishExpand({ ...state, mode, pending: null, error: null, notice: null });
    }

    case "togglePin": {
      const pinned = new Set(state.pinned);
      if (pinned.delete(action.id)) {
        const next: ExplorationState = {
          ...state,
          pinned,
          pinOrder: state.pinOrder.filter((id) => id !== action.id),
          pinEpoch: state.pinEpoch + 1,
          unpinEpoch: state.unpinEpoch + 1,
        };
        const run = state.expand;
        if (!run?.queue.includes(action.id)) return next;
        // "Expand pinned" expands pinned sources only: an unpinned source
        // leaves the queue (a chunk in flight skips it on arrival).
        const expand: ExpandRun = {
          ...run,
          queue: run.queue.filter((id) => id !== action.id),
          sourceIds: run.sourceIds.filter((id) => id !== action.id),
        };
        if (expand.queue.length > 0 || state.pending?.kind === "topup") return { ...next, expand };
        return finishExpand({ ...next, expand, error: state.error?.request.kind === "topup" ? null : state.error });
      }
      pinned.add(action.id);
      return { ...state, pinned, pinOrder: [...state.pinOrder, action.id], pinEpoch: state.pinEpoch + 1 };
    }

    case "pinFromDrag": {
      if (state.pinned.has(action.id)) return state;
      return explorationReducer(state, { type: "togglePin", id: action.id });
    }

    case "requestStarted": {
      let next: ExplorationState = {
        ...state,
        pending: action.pending,
        error: null,
        exclusionsCapped: action.exclusionsCapped,
      };
      if (action.pending.kind === "range") {
        if (next.notice && RANGE_NOTICES.has(next.notice.kind)) next = { ...next, notice: null };
        // Navigating a range supersedes a running expansion.
        next = finishExpand(next);
      }
      return next;
    }

    case "rangeLoaded": {
      const pending = state.pending;
      if (!pending || pending.id !== action.id || pending.kind !== "range") return state;
      return applyRange(state, pending, action.response);
    }

    case "topUpLoaded": {
      const pending = state.pending;
      if (!pending || pending.id !== action.id || pending.kind !== "topup") return state;
      return applyTopUp(state, pending, action.response);
    }

    case "requestFailed": {
      const pending = state.pending;
      if (!pending || pending.id !== action.id) return state;
      // Branches are untouched: valid results stay visible after an error.
      const rateLimited = action.kind === "rate_limited";
      const retryAfter = rateLimited ? action.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS : null;
      const retryAt = retryAfter !== null ? action.now + retryAfter * 1000 : null;
      if (pending.kind === "topup" && state.expand) {
        if (rateLimited) {
          return { ...state, pending: null, expand: { ...state.expand, phase: "paused", retryAfter, resumeAt: retryAt } };
        }
        return {
          ...state,
          pending: null,
          expand: { ...state.expand, phase: "failed" },
          error: { request: specOf(pending), kind: action.kind, retryAfter: null, retryAt: null },
        };
      }
      return { ...state, pending: null, error: { request: specOf(pending), kind: action.kind, retryAfter, retryAt } };
    }

    case "versionChanged": {
      // A new version is a different source record: its branches reset, drop
      // what the old version's lookup found (no provider id, exhaustion) and
      // the next tap loads 1–30 for it.
      const { groupId, canonicalKey } = action;
      const branches: Record<BranchKey, BranchMeta> = { ...state.branches };
      let changed = false;
      for (const branch of Object.values(state.branches)) {
        if (branch.sourceId !== groupId || branch.sourceKey === canonicalKey) continue;
        const reset = forgetVersion(retire(branch, state, state.edgeEnds));
        if (reset === branch) continue;
        branches[branch.key] = reset;
        changed = true;
      }
      const dropPending =
        state.pending?.kind === "range" && state.pending.sourceId === groupId && state.pending.sourceKey !== canonicalKey;
      if (!changed && !dropPending) return state;
      const activeBySource: Record<string, BranchKey> = { ...state.activeBySource };
      const primary = activeBySource[groupId];
      if (!primary || !branches[primary]?.active) {
        const stillActive = Object.values(branches).find((branch) => branch.sourceId === groupId && branch.active);
        if (stillActive) activeBySource[groupId] = stillActive.key;
        else delete activeBySource[groupId];
      }
      return { ...state, branches, activeBySource, pending: dropPending ? null : state.pending };
    }

    case "expandPlanned": {
      if (state.expand || action.sourceIds.length === 0) return state;
      return {
        ...state,
        pending: state.pending?.kind === "range" ? null : state.pending,
        notice: null,
        error: null,
        expand: {
          phase: action.sourceIds.length > TOPUP_CONFIRM_ABOVE ? "confirm" : "running",
          mode: state.mode,
          sourceIds: action.sourceIds,
          queue: action.sourceIds,
          failed: [],
          added: 0,
          upTo: action.upTo,
          retryAfter: null,
          resumeAt: null,
        },
      };
    }

    case "expandNothing":
      return { ...state, notice: { kind: "nothingToExpand", params: { count: state.rangeSize } } };

    case "expandConfirmed":
      if (state.expand?.phase !== "confirm") return state;
      return { ...state, expand: { ...state.expand, phase: "running" } };

    case "expandResumed": {
      const run = state.expand;
      if (!run || (run.phase !== "paused" && run.phase !== "failed")) return state;
      return {
        ...state,
        error: state.error?.request.kind === "topup" ? null : state.error,
        expand: { ...run, phase: "running", retryAfter: null, resumeAt: null },
      };
    }

    case "expandCancelled": {
      if (!state.expand) return state;
      return finishExpand({
        ...state,
        pending: state.pending?.kind === "topup" ? null : state.pending,
        error: state.error?.request.kind === "topup" ? null : state.error,
      });
    }

    case "dismissNotice":
      return state.notice ? { ...state, notice: null } : state;

    case "clearError":
      return state.error ? { ...state, error: null } : state;
  }
}

/* ── Selectors ────────────────────────────────────────────── */

/** Base nodes ∪ pins ∪ every branch's source and members. */
export function visibleNodeIds(state: ExplorationState): Set<string> {
  const visible = new Set<string>(state.baseIds);
  for (const id of state.pinned) visible.add(id);
  for (const branch of Object.values(state.branches)) {
    visible.add(branch.sourceId);
    for (const id of branch.memberIds) visible.add(id);
  }
  return visible;
}

/** Base and branch edges whose endpoints are both visible. */
export function visibleEdgeKeys(state: ExplorationState, visible = visibleNodeIds(state)): Set<string> {
  const keys = new Set<string>();
  const consider = (key: string) => {
    const pair = state.edgeEnds[key];
    if (pair && visible.has(pair[0]) && visible.has(pair[1])) keys.add(key);
  };
  state.baseEdgeKeys.forEach(consider);
  for (const branch of Object.values(state.branches)) branch.edgeKeys.forEach(consider);
  return keys;
}

/** The active branch of `sourceId` under the current (or given) mode. */
export function currentBranch(state: ExplorationState, sourceId: string, mode: Mode = state.mode): BranchMeta | undefined {
  const branch = state.branches[branchKey(sourceId, mode.direction, mode.order)];
  return branch?.active ? branch : undefined;
}

/** Unpinned members of the (source, mode) branch — the per-branch top-up count. */
export function connectedGroupKeys(state: ExplorationState, sourceId: string, mode: Mode = state.mode): string[] {
  const branch = currentBranch(state, sourceId, mode);
  return branch ? branch.memberIds.filter((id) => id !== sourceId && !state.pinned.has(id)) : [];
}

/** Pinned groups other than the source, capped at the most recent MAX_EXCLUSIONS. */
export function exclusionsFor(state: ExplorationState, sourceId: string | null): { keys: string[]; capped: boolean } {
  const keys = state.pinOrder.filter((id) => id !== sourceId);
  if (keys.length <= MAX_EXCLUSIONS) return { keys, capped: false };
  return { keys: keys.slice(keys.length - MAX_EXCLUSIONS), capped: true };
}

/**
 * Source whose first range a mode switch should load (decision 2), if any:
 * the selected source when it has a loaded branch, or a range of it was
 * loading or failed. Evaluate it on the state from before the switch.
 */
export function modeSwitchAutoLoad(state: ExplorationState): string | null {
  const id = state.selectedId;
  if (!id) return null;
  const request = state.pending ?? state.error?.request;
  const loading = request?.kind === "range" && request.sourceId === id;
  return state.activeBySource[id] || loading ? id : null;
}

export interface RangeWindowItem {
  index: number;
  start: number;
  end: number;
  current: boolean;
}

function windowIndices(count: number, current: number, includeLast: boolean): number[] {
  const wanted = [0, current - 1, current, current + 1];
  if (includeLast) wanted.push(count - 1);
  return [...new Set(wanted)].filter((index) => index >= 0 && index < count).sort((a, b) => a - b);
}

/**
 * First, previous, current, next and last ranges without duplicates, e.g.
 * (1000, 9) → 1–30 · 241–270 · 271–300 · 301–330 · 991–1000.
 */
export function rangeWindow(total: number, active: number, size: number = DEFAULT_RANGE_SIZE): RangeWindowItem[] {
  if (total <= 0 || size <= 0) return [];
  const count = Math.ceil(total / size);
  const current = Math.min(Math.max(active, 0), count - 1);
  return windowIndices(count, current, true).map((index) => ({
    index,
    start: index * size + 1,
    end: Math.min((index + 1) * size, total),
    current: index === current,
  }));
}

export type RangeItem =
  | { kind: "range"; index: number; start: number; end: number; current: boolean; loaded: boolean; gapBefore: boolean }
  | { kind: "last"; current: false; loaded: false; gapBefore: boolean };

export interface RangeSummary {
  start: number;
  end: number;
  total: number;
  totalExact: boolean;
  totalCapped: boolean;
  providerTotal: number | null;
  maxResults: number;
}

export interface RangeControls {
  /** false until the (source, mode) branch has been range-navigated. */
  loaded: boolean;
  items: RangeItem[];
  summary: RangeSummary | null;
  /** Pins changed since the current range was computed: tapping it repartitions. */
  pinsChanged: boolean;
}

function notLoadedItem(size: number): RangeItem {
  return { kind: "range", index: 0, start: 1, end: size, current: true, loaded: false, gapBefore: false };
}

/**
 * Range navigation for a source under the current mode. Before the first
 * load (decision 1) it offers only 1–30, current but not loaded. When the
 * total is an estimate the last numeric range becomes a "Last" item.
 */
export function rangeControls(state: ExplorationState, sourceId: string): RangeControls {
  const branch = currentBranch(state, sourceId);
  if (!branch || branch.rangeIndex === null || branch.rangeStart === null || branch.rangeEnd === null || branch.totalAvailable === null) {
    return { loaded: false, items: [notLoadedItem(state.rangeSize)], summary: null, pinsChanged: false };
  }
  const size = branch.rangeSize;
  const total = branch.totalAvailable;
  const pinsChanged = branch.loadedPinEpoch !== state.pinEpoch;
  const summary: RangeSummary = {
    start: total > 0 ? branch.rangeStart + 1 : 0,
    end: total > 0 ? branch.rangeEnd : 0,
    total,
    totalExact: branch.totalExact,
    totalCapped: branch.totalCapped,
    providerTotal: branch.providerTotal,
    maxResults: branch.maxResults,
  };
  if (total <= 0) {
    return { loaded: true, items: pinsChanged ? [notLoadedItem(size)] : [], summary, pinsChanged };
  }

  const exact = branch.totalExact;
  let count = Math.ceil(total / size);
  if (!exact && branch.hasMore) count = Math.max(count, branch.rangeIndex + 2);
  const current = Math.min(branch.rangeIndex, count - 1);
  const items: RangeItem[] = [];
  let previous = -1;
  for (const index of windowIndices(count, current, exact)) {
    const isCurrent = index === current;
    items.push({
      kind: "range",
      index,
      start: isCurrent ? branch.rangeStart + 1 : index * size + 1,
      end: isCurrent ? branch.rangeEnd : exact ? Math.min((index + 1) * size, total) : (index + 1) * size,
      current: isCurrent,
      loaded: true,
      gapBefore: previous >= 0 && index > previous + 1,
    });
    previous = index;
  }
  if (!exact) items.push({ kind: "last", current: false, loaded: false, gapBefore: true });
  return { loaded: true, items, summary, pinsChanged };
}

export interface PlannedTopUp {
  sourceId: string;
  connectedGroupKeys: string[];
  need: number;
}

export interface TopUpPlan {
  toRequest: PlannedTopUp[];
  skippedFull: string[];
  skippedExhausted: string[];
  skippedNoProvider: string[];
  /** Upper bound of new papers (the confirmation text). */
  upTo: number;
  needsConfirmation: boolean;
  /** Source ids per sequential request. */
  chunks: string[][];
}

/**
 * Which pinned sources "Expand pinned nodes" tops up, counted per branch
 * (source, direction, order): a source is skipped when its branch already
 * has `target` unpinned members, has no provider id, or is exhausted with no
 * unpin since. A source whose branch holds only the final partial range
 * (e.g. 991–1000) is topped up with the next eligible groups in order.
 */
export function planTopUp(state: ExplorationState, target: number = state.rangeSize, mode: Mode = state.mode): TopUpPlan {
  const plan: TopUpPlan = {
    toRequest: [],
    skippedFull: [],
    skippedExhausted: [],
    skippedNoProvider: [],
    upTo: 0,
    needsConfirmation: false,
    chunks: [],
  };
  // The lookup is per source version, so any active branch's answer holds.
  const noProvider = new Set(
    Object.values(state.branches)
      .filter((branch) => branch.active && branch.reason === "no_provider_id")
      .map((branch) => branch.sourceId),
  );
  for (const sourceId of state.pinOrder) {
    const connected = connectedGroupKeys(state, sourceId, mode);
    const branch = currentBranch(state, sourceId, mode);
    if (noProvider.has(sourceId)) plan.skippedNoProvider.push(sourceId);
    else if (connected.length >= target) plan.skippedFull.push(sourceId);
    else if (branch?.exhausted && branch.exhaustedUnpinEpoch === state.unpinEpoch) plan.skippedExhausted.push(sourceId);
    else {
      const need = target - connected.length;
      plan.toRequest.push({ sourceId, connectedGroupKeys: connected, need });
      plan.upTo += need;
    }
  }
  plan.needsConfirmation = plan.toRequest.length > TOPUP_CONFIRM_ABOVE;
  for (let i = 0; i < plan.toRequest.length; i += TOPUP_CHUNK) {
    plan.chunks.push(plan.toRequest.slice(i, i + TOPUP_CHUNK).map((item) => item.sourceId));
  }
  return plan;
}

/* ── Request bodies ───────────────────────────────────────── */

export function buildRangeRequest(
  state: ExplorationState,
  spec: RangeRequestSpec,
  sourceKey: string,
): { body: RelatedRangeRequest; capped: boolean } {
  const exclusions = exclusionsFor(state, spec.sourceId);
  const size = state.branches[branchKey(spec.sourceId, spec.mode.direction, spec.mode.order)]?.rangeSize ?? state.rangeSize;
  return {
    body: {
      source_key: sourceKey,
      source_group_key: spec.sourceId,
      direction: spec.mode.direction,
      order: spec.mode.order,
      range_start: spec.last || spec.rangeIndex === null ? 0 : spec.rangeIndex * size,
      last: spec.last,
      exclude_group_keys: exclusions.keys,
    },
    capped: exclusions.capped,
  };
}

export function buildTopUpRequest(
  state: ExplorationState,
  spec: TopUpRequestSpec,
  sourceKeyOf: (id: string) => string,
): { body: TopUpRequest; capped: boolean } {
  const exclusions = exclusionsFor(state, null);
  return {
    body: {
      direction: spec.mode.direction,
      order: spec.mode.order,
      target_per_source: state.rangeSize,
      exclude_group_keys: exclusions.keys,
      sources: spec.batch.map((id) => ({
        source_key: sourceKeyOf(id),
        source_group_key: id,
        connected_group_keys: connectedGroupKeys(state, id, spec.mode).slice(0, MAX_CONNECTED),
      })),
    },
    capped: exclusions.capped,
  };
}
