import { useEffect, useMemo, useRef, useState } from "react";
import { isCancel } from "axios";
import { graph as graphApi } from "@/lib/api";
import { apiStatus, retryAfterSeconds } from "@/lib/apiError";
import type { GraphCatalog } from "@/components/graph/graphCatalog";
import {
  buildRangeRequest,
  buildTopUpRequest,
  currentBranch,
  explorationReducer,
  initialExplorationState,
  MAX_AUTO_CONTINUE,
  modeSwitchAutoLoad,
  planTopUp,
  TOPUP_CHUNK,
  type ErrorKind,
  type ExplorationAction,
  type ExplorationState,
  type Mode,
  type PendingRange,
  type PendingTopUp,
  type RangeRequestSpec,
  type TopUpRequestSpec,
} from "@/components/graph/graphExploration";
import type { CitingOrder, GraphResponse, RelationDirection } from "@/types";

export interface GraphExploration {
  state: ExplorationState;
  /** Bumped whenever the catalog changes (payloads the canvas must pick up). */
  catalogRevision: number;
  select(id: string | null): void;
  setDirection(direction: RelationDirection): void;
  setOrder(order: CitingOrder): void;
  togglePin(id: string): void;
  pinFromDrag(id: string): void;
  /** Load a range of the selected source under the current mode. */
  loadRange(selection: { index: number } | { last: true }): void;
  /** Double-click: select, and load 1–30 unless the branch is already navigated. */
  loadFirstRangeFor(id: string): void;
  expandPinned(): void;
  confirmExpand(): void;
  cancelExpand(): void;
  retry(): void;
  dismissNotice(): void;
  versionChanged(groupId: string, canonicalKey: string): void;
}

export function errorKind(err: unknown): ErrorKind {
  const status = apiStatus(err);
  if (status === null) return "network";
  if (status === 429) return "rate_limited";
  if (status === 502) return "provider";
  return "server";
}

/**
 * Network layer over the exploration reducer. Every request carries a
 * monotonically increasing id and one shared AbortController: a new request
 * aborts the previous one, and a response is applied only while its id is
 * still the pending one. Selecting never fetches (decision 1); a mode switch
 * with a loaded selected source reloads its first range (decision 2).
 */
export function useGraphExploration(base: GraphResponse | undefined, catalog: GraphCatalog): GraphExploration {
  const [state, setState] = useState<ExplorationState>(() => initialExplorationState());
  const [catalogRevision, setCatalogRevision] = useState(0);
  const stateRef = useRef(state);
  const controllerRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  const actions = useMemo(() => {
    // The reducer runs synchronously on the ref so chained steps (a mode
    // switch, then its auto-load) see the state they just produced.
    const dispatch = (action: ExplorationAction) => {
      const next = explorationReducer(stateRef.current, action);
      if (next === stateRef.current) return;
      stateRef.current = next;
      setState(next);
    };

    const abort = () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };

    /** Dispatch, aborting the in-flight request if the action dropped it. */
    const dispatchDropping = (action: ExplorationAction) => {
      const before = stateRef.current.pending;
      dispatch(action);
      if (before && stateRef.current.pending !== before) abort();
    };

    const addToCatalog = (data: Parameters<GraphCatalog["add"]>[0]) => {
      catalog.add(data);
      setCatalogRevision((revision) => revision + 1);
    };

    const nextSignal = () => {
      abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      return controller.signal;
    };

    const stamp = () => ({
      id: ++seqRef.current,
      pinEpoch: stateRef.current.pinEpoch,
      unpinEpoch: stateRef.current.unpinEpoch,
    });

    const isPending = (id: number) => stateRef.current.pending?.id === id;

    const fail = (id: number, err: unknown) => {
      if (isCancel(err) || !isPending(id)) return;
      const kind = errorKind(err);
      dispatch({
        type: "requestFailed",
        id,
        kind,
        retryAfter: kind === "rate_limited" ? retryAfterSeconds(err) : null,
        now: Date.now(),
      });
    };

    const startRange = (
      spec: RangeRequestSpec,
      autoContinue = 0,
      progress: { scanned: number | null; providerTotal: number | null } = { scanned: null, providerTotal: null },
    ) => {
      const sourceKey = catalog.sourceKey(spec.sourceId);
      const { body, capped } = buildRangeRequest(stateRef.current, spec, sourceKey);
      const pending: PendingRange = { ...spec, ...stamp(), sourceKey, autoContinue, ...progress };
      const signal = nextSignal();
      dispatch({ type: "requestStarted", pending, exclusionsCapped: capped });
      graphApi.related(body, { signal }).then(
        (response) => {
          if (!isPending(pending.id)) return;
          // The server stopped scanning at its deadline: continue the scan
          // (the snapshot grows server-side) before showing the range.
          if (response.scan_incomplete && autoContinue < MAX_AUTO_CONTINUE) {
            startRange(spec, autoContinue + 1, { scanned: response.scanned, providerTotal: response.provider_total });
            return;
          }
          addToCatalog(response);
          dispatch({ type: "rangeLoaded", id: pending.id, response });
        },
        (err: unknown) => fail(pending.id, err),
      );
    };

    /** Send the next chunk of a running "Expand pinned" run, if any. */
    const pump = () => {
      const current = stateRef.current;
      const run = current.expand;
      if (!run || run.phase !== "running" || current.pending || run.queue.length === 0) return;
      const spec: TopUpRequestSpec = { kind: "topup", mode: run.mode, batch: run.queue.slice(0, TOPUP_CHUNK) };
      const { body, capped } = buildTopUpRequest(current, spec, (id) => catalog.sourceKey(id));
      const pending: PendingTopUp = { ...spec, ...stamp() };
      const signal = nextSignal();
      dispatch({ type: "requestStarted", pending, exclusionsCapped: capped });
      graphApi.topUp(body, { signal }).then(
        (response) => {
          if (!isPending(pending.id)) return;
          addToCatalog(response);
          dispatch({ type: "topUpLoaded", id: pending.id, response });
          pump();
        },
        (err: unknown) => fail(pending.id, err),
      );
    };

    const setMode = (mode: Partial<Mode>) => {
      const before = stateRef.current;
      dispatch({ type: "setMode", mode });
      if (stateRef.current === before) return;
      abort();
      const sourceId = modeSwitchAutoLoad(before);
      if (sourceId) {
        startRange({ kind: "range", sourceId, mode: stateRef.current.mode, rangeIndex: 0, last: false, retireOtherModes: true });
      }
    };

    return {
      dispatch,
      abort,
      pump,
      reset(next: GraphResponse) {
        abort();
        catalog.reset();
        addToCatalog(next);
        dispatch({ type: "baseLoaded", base: next });
      },
      select(id: string | null) {
        dispatchDropping({ type: "select", id });
      },
      setDirection(direction: RelationDirection) {
        setMode({ direction });
      },
      setOrder(order: CitingOrder) {
        setMode({ order });
      },
      togglePin(id: string) {
        dispatch({ type: "togglePin", id });
      },
      pinFromDrag(id: string) {
        dispatch({ type: "pinFromDrag", id });
      },
      loadRange(selection: { index: number } | { last: true }) {
        const current = stateRef.current;
        if (!current.selectedId) return;
        const last = "last" in selection;
        startRange({
          kind: "range",
          sourceId: current.selectedId,
          mode: current.mode,
          rangeIndex: "index" in selection ? selection.index : null,
          last,
        });
      },
      loadFirstRangeFor(id: string) {
        dispatchDropping({ type: "select", id });
        const current = stateRef.current;
        const loading = current.pending?.kind === "range" && current.pending.sourceId === id;
        const branch = currentBranch(current, id);
        if (!loading && (!branch || branch.rangeIndex === null)) {
          startRange({ kind: "range", sourceId: id, mode: current.mode, rangeIndex: 0, last: false });
        }
      },
      expandPinned() {
        const current = stateRef.current;
        if (current.pinned.size === 0 || current.expand) return;
        const plan = planTopUp(current);
        if (plan.toRequest.length === 0) {
          dispatch({ type: "expandNothing" });
          return;
        }
        dispatchDropping({
          type: "expandPlanned",
          sourceIds: plan.toRequest.map((item) => item.sourceId),
          upTo: plan.upTo,
        });
        pump();
      },
      confirmExpand() {
        dispatch({ type: "expandConfirmed" });
        pump();
      },
      cancelExpand() {
        dispatchDropping({ type: "expandCancelled" });
      },
      retry() {
        const current = stateRef.current;
        const phase = current.expand?.phase;
        if (phase === "failed" || phase === "paused") {
          dispatch({ type: "expandResumed" });
          pump();
          return;
        }
        // Same logical request; the body (exclusions, source key) is rebuilt.
        const request = current.error?.request;
        if (request?.kind === "range") startRange(request);
      },
      dismissNotice() {
        dispatch({ type: "dismissNotice" });
      },
      versionChanged(groupId: string, canonicalKey: string) {
        if (catalog.selectVersion(groupId, canonicalKey)) setCatalogRevision((revision) => revision + 1);
        dispatchDropping({ type: "versionChanged", groupId, canonicalKey });
      },
    };
  }, [catalog]);

  useEffect(() => {
    if (base) actions.reset(base);
  }, [base, actions]);

  // "Expand pinned" pauses on 429 and resumes by itself after Retry-After.
  const resumeAt = state.expand?.phase === "paused" ? state.expand.resumeAt : null;
  useEffect(() => {
    if (resumeAt === null) return;
    const timer = window.setTimeout(() => {
      actions.dispatch({ type: "expandResumed" });
      actions.pump();
    }, Math.max(0, resumeAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [resumeAt, actions]);

  useEffect(() => () => actions.abort(), [actions]);

  return {
    state,
    catalogRevision,
    select: actions.select,
    setDirection: actions.setDirection,
    setOrder: actions.setOrder,
    togglePin: actions.togglePin,
    pinFromDrag: actions.pinFromDrag,
    loadRange: actions.loadRange,
    loadFirstRangeFor: actions.loadFirstRangeFor,
    expandPinned: actions.expandPinned,
    confirmExpand: actions.confirmExpand,
    cancelExpand: actions.cancelExpand,
    retry: actions.retry,
    dismissNotice: actions.dismissNotice,
    versionChanged: actions.versionChanged,
  };
}
