import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw, X } from "lucide-react";
import type { ExplorationError, ExplorationState, Notice, RankingStall } from "@/components/graph/graphExploration";
import { apiErrorDetail, apiErrorText } from "@/lib/apiError";

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
    case "edgesPartial":
      return t("graph.edgesPartial");
  }
}

/**
 * `err` as apiErrorText should read it after `seconds` of the wait have
 * passed: its Retry-After becomes the time left (none once it is over).
 */
function withRetryAfter(err: unknown, seconds: number): unknown {
  if (typeof err !== "object" || err === null) return err;
  const response = (err as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return err;
  const headers = seconds > 0 ? { "retry-after": String(seconds) } : {};
  return { ...err, response: { ...response, headers } };
}

/** Message for a failed related-paper request; `seconds` is the rate-limit countdown. */
export function errorText(error: ExplorationError, t: TFunction, seconds: number): string {
  if (error.kind === "rate_limited") {
    return apiErrorText(withRetryAfter(error.cause, seconds), t, t("graph.rateLimited", { seconds }));
  }
  // A missing or rejected API key: waiting will not help, the operator must act.
  if (apiErrorDetail(error.cause)?.reason === "not_configured") return t("errors.provider_not_configured");
  return apiErrorText(error.cause, t, t(error.kind === "provider" ? "graph.providerUnavailable" : "graph.loadFailed"));
}

/** "Ranking N of about M": how far the provider's list has been collected. */
function rankingText(key: "ranking" | "rankingPaused", scanned: number, total: number | null, t: TFunction): string {
  return total === null ? t(`graph.${key}Count`, { scanned }) : t(`graph.${key}`, { scanned, total });
}

/** Loading text of the request in flight, if it is a range load. */
export function pendingText(state: ExplorationState, t: TFunction): string | null {
  const pending = state.pending;
  if (pending?.kind !== "range") return null;
  if (pending.ranking && pending.scanned !== null) return rankingText("ranking", pending.scanned, pending.providerTotal, t);
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
  /** Resumes a range still being ranked by the provider. */
  onContinueRanking: () => void;
  /** Offers Cancel next to that progress. */
  onCancelExpand?: () => void;
}

/** Text for a range whose ranking stopped before its list was complete. */
export function rankingStallText(stall: RankingStall, t: TFunction): string {
  return rankingText("rankingPaused", stall.scanned, stall.providerTotal, t);
}

/**
 * Live status of related-paper requests: loading and ranking progress,
 * errors with Retry (and a countdown after a rate limit), a stalled ranking
 * with Continue, and notices. Loaded branches always stay visible.
 */
export default function GraphStatus({
  state,
  showExpandProgress = false,
  onRetry,
  onDismiss,
  onContinueRanking,
  onCancelExpand,
}: GraphStatusProps) {
  const { t } = useTranslation();
  const { error, notice, expand, rankingStall } = state;
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
        <p className="graph-status-line graph-status-line--warning">{t("graph.expandPaused", { seconds: resumeIn })}</p>
      )}
      {rankingStall && (
        <p className="graph-status-line">
          <span>{rankingStallText(rankingStall, t)}</span>
          <button type="button" className="btn btn-secondary graph-btn" onClick={onContinueRanking}>
            {t("common.continue")}
          </button>
        </p>
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
