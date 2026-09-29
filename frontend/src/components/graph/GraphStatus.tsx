import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw, X } from "lucide-react";
import type { ExplorationError, ExplorationState, Notice } from "@/components/graph/graphExploration";

/** Whole seconds left until `until` (epoch ms), ticking once a second. */
export function useCountdown(until: number | null): number {
  const [, setTick] = useState(0);
  const remaining = until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000));
  useEffect(() => {
    if (until === null) return;
    const timer = window.setInterval(() => {
      setTick((tick) => tick + 1);
      if (Date.now() >= until) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return remaining;
}

export function noticeText(notice: Notice, t: TFunction): string {
  const params = notice.params ?? {};
  switch (notice.kind) {
    case "rangeAdjusted":
      return t("graph.rangeAdjusted", params);
    case "empty":
      return t(params.direction === "cites" ? "graph.noReferences" : "graph.noCiters");
    case "allPinned":
      return t("graph.allPinned");
    case "noProviderId":
      return t("graph.noProviderId");
    case "nothingToExpand":
      return t("graph.nothingToExpand", { count: Number(params.count ?? 0) });
    case "partialTopUp": {
      const failed = Number(params.failed ?? 0);
      const done = t("graph.expandPartial", { done: params.done, total: params.total });
      return failed > 0 ? `${done} ${t("graph.expandFailedSome", { count: failed })}` : done;
    }
  }
}

/** Message for a failed related-paper request; `seconds` is the 429 countdown. */
export function errorText(error: ExplorationError, t: TFunction, seconds: number): string {
  if (error.kind === "rate_limited") return t("graph.rateLimited", { seconds });
  return error.kind === "provider" ? t("graph.providerUnavailable") : t("graph.loadFailed");
}

/** Loading text of the request in flight, if it is a range load. */
export function pendingText(state: ExplorationState, t: TFunction): string | null {
  const pending = state.pending;
  if (pending?.kind !== "range") return null;
  if (pending.autoContinue > 0 && pending.scanned !== null) {
    return t("graph.scanning", { scanned: pending.scanned, total: pending.providerTotal ?? pending.scanned });
  }
  if (pending.last || pending.rangeIndex === null) return t("common.loading");
  const start = pending.rangeIndex * state.rangeSize + 1;
  return t("graph.loadingRange", { start, end: start + state.rangeSize - 1 });
}

interface GraphStatusProps {
  state: ExplorationState;
  /** Also report "Expand pinned" progress (when its own control is hidden). */
  showExpandProgress?: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  /** Offers Cancel next to that progress. */
  onCancelExpand?: () => void;
}

/**
 * Live status of related-paper requests: loading, errors with Retry (and a
 * countdown after a 429), and notices. Loaded branches always stay visible.
 */
export default function GraphStatus({
  state,
  showExpandProgress = false,
  onRetry,
  onDismiss,
  onCancelExpand,
}: GraphStatusProps) {
  const { t } = useTranslation();
  const { error, notice, expand } = state;
  const retryIn = useCountdown(error?.retryAt ?? null);
  const resumeIn = useCountdown(expand?.phase === "paused" ? expand.resumeAt : null);
  const loading = pendingText(state, t);

  const message = error ? errorText(error, t, retryIn) : null;
  const expandProgress = showExpandProgress && expand && expand.phase !== "confirm";

  return (
    <div className="graph-status" role="status" aria-live="polite" data-testid="graph-status">
      {loading && (
        <p className="graph-status-line">
          <Loader2 size={14} className="spin" aria-hidden="true" />
          {loading}
        </p>
      )}
      {expandProgress && (
        <p className="graph-status-line">
          <span>
            {t("graph.expanding", { done: expand.sourceIds.length - expand.queue.length, total: expand.sourceIds.length })}
          </span>
          {onCancelExpand && (
            <button type="button" className="btn btn-secondary graph-btn" onClick={onCancelExpand}>
              {t("common.cancel")}
            </button>
          )}
        </p>
      )}
      {expand?.phase === "paused" && (
        <p className="graph-status-line graph-status-line--warning">{t("graph.rateLimited", { seconds: resumeIn })}</p>
      )}
      {message && (
        <p className="graph-status-line graph-status-line--error">
          <span>{message}</span>
          <button type="button" className="btn btn-secondary graph-btn" onClick={onRetry} disabled={retryIn > 0}>
            <RotateCcw size={14} aria-hidden="true" />
            {t("common.retry")}
          </button>
        </p>
      )}
      {notice && (
        <p className="graph-status-line">
          <span>{noticeText(notice, t)}</span>
          <button type="button" className="btn-ghost graph-icon-btn" onClick={onDismiss} aria-label={t("common.dismiss")}>
            <X size={14} aria-hidden="true" />
          </button>
        </p>
      )}
      {state.exclusionsCapped && <p className="graph-hint">{t("graph.exclusionsCapped")}</p>}
    </div>
  );
}
