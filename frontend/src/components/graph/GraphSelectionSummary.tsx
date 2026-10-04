import { useMemo, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { PinToggle } from "@/components/graph/GraphNodePopup";
import GraphStatus from "@/components/graph/GraphStatus";
import { adjacentRanges, isRangeCapped, type RangeSelection } from "@/components/graph/RangeNavigator";
import { graphDotClass } from "@/components/graph/nodeStyle";
import { isUnresolved, paperTitle } from "@/components/graph/paperText";
import type { ExplorationState, RangeControls } from "@/components/graph/graphExploration";
import type { GraphNode } from "@/types";

interface GraphSelectionSummaryProps {
  state: ExplorationState;
  node: GraphNode | null;
  /** The selected paper is in the library (its dot takes the saved colour). */
  saved?: boolean;
  rangeControls: RangeControls | null;
  titleRef?: Ref<HTMLButtonElement>;
  onTogglePin: () => void;
  /** The title opens the controls sheet on the selected paper. */
  onOpenPaper: () => void;
  onRange: (selection: RangeSelection) => void;
  onViewDetails: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  onContinueRanking: () => void;
  onCancelExpand: () => void;
}

/**
 * Compact in-flow row under the canvas, rendered only while there is
 * something to show. Line one: the selection ring, the paper's title (opens
 * the controls sheet) and Pin. Line two: "Citers · Most cited · 31–60 of N"
 * (the range reloads or loads it), Next and Details. Then the live status
 * of related-paper requests.
 */
export default function GraphSelectionSummary({
  state,
  node,
  saved = false,
  rangeControls,
  titleRef,
  onTogglePin,
  onOpenPaper,
  onRange,
  onViewDetails,
  onRetry,
  onDismiss,
  onContinueRanking,
  onCancelExpand,
}: GraphSelectionSummaryProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = useMemo(() => new Intl.NumberFormat(language), [language]);
  const current = rangeControls?.items.find((item) => item.kind === "range" && item.current);
  const range = current?.kind === "range" ? current : null;
  const next = rangeControls ? adjacentRanges(rangeControls).next : null;
  const summary = rangeControls?.summary;
  const title = node ? paperTitle(node.selected_version, t) : "";
  const { direction, order } = state.mode;

  // The same rule as the desktop range summary (rangeSummaryText): a capped
  // list names its reachable cap, never an unreachable provider total.
  let total: string | null = null;
  if (range?.loaded && summary && summary.total > 0) {
    total = isRangeCapped(summary)
      ? t("graph.summaryOfCapped", { cap: summary.maxResults })
      : t(summary.totalExact ? "graph.summaryOf" : "graph.summaryOfApprox", { total: summary.total });
  }

  return (
    <div className="graph-summary" data-testid="graph-summary">
      {node && (
        <>
          <div className="graph-summary-row">
            <span className={graphDotClass(state.pinned.has(node.id), saved, true)} aria-hidden="true" />
            <button
              ref={titleRef}
              type="button"
              className="graph-summary-title"
              aria-haspopup="dialog"
              onClick={onOpenPaper}
            >
              {title}
            </button>
            <PinToggle
              pinned={state.pinned.has(node.id)}
              title={title}
              className="graph-pin-toggle--quiet"
              onToggle={onTogglePin}
            />
          </div>
          <div className="graph-summary-row graph-summary-row--meta">
            <p className="graph-summary-meta">
              <span>
                {direction === "cites" ? t("graph.references") : t("graph.citers")} ·{" "}
                {order === "recent" ? t("graph.mostRecent") : t("graph.topCited")}
              </span>
              {range && (
                <>
                  <span aria-hidden="true"> · </span>
                  <button
                    type="button"
                    className={`graph-range-btn graph-range-chip is-current${range.loaded ? "" : " is-unloaded"}`}
                    aria-label={
                      range.loaded
                        ? t("graph.showRange", { start: range.start, end: range.end })
                        : t("graph.rangeNotLoaded", { start: range.start, end: range.end })
                    }
                    onClick={() => onRange({ index: range.index })}
                  >
                    {number.format(range.start)}–{number.format(range.end)}
                  </button>
                  {total && <span className="tabular"> {total}</span>}
                </>
              )}
            </p>
            <div className="graph-summary-actions">
              {next && (
                <button
                  type="button"
                  className="btn btn-secondary btn--sm"
                  title={t("graph.showRange", { start: next.start, end: next.end })}
                  onClick={() => onRange({ index: next.index })}
                >
                  {t("graph.nextCount", { size: next.end - next.start + 1 })}
                </button>
              )}
              {!isUnresolved(node.selected_version) && (
                <button
                  type="button"
                  className="btn btn-primary btn--sm"
                  aria-label={t("paper.viewDetails")}
                  onClick={onViewDetails}
                >
                  {t("graph.details")}
                </button>
              )}
            </div>
          </div>
        </>
      )}
      <GraphStatus
        state={state}
        showExpandProgress
        onRetry={onRetry}
        onDismiss={onDismiss}
        onContinueRanking={onContinueRanking}
        onCancelExpand={onCancelExpand}
      />
    </div>
  );
}
