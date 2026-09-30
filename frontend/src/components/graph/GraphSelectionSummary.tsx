import { useMemo, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { PinToggle } from "@/components/graph/GraphNodePopup";
import GraphStatus from "@/components/graph/GraphStatus";
import type { RangeSelection } from "@/components/graph/RangeNavigator";
import { isUnresolved, paperTitle } from "@/components/graph/paperText";
import type { ExplorationState, RangeControls } from "@/components/graph/graphExploration";
import type { GraphNode } from "@/types";

interface GraphSelectionSummaryProps {
  state: ExplorationState;
  node: GraphNode | null;
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
 * something to show: the selected paper (Pin, title, current range, details)
 * and the live status of related-paper requests.
 */
export default function GraphSelectionSummary({
  state,
  node,
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
  const title = node ? paperTitle(node.selected_version, t) : "";

  return (
    <div className="graph-summary" data-testid="graph-summary">
      {node && (
        <div className="graph-summary-row">
          <PinToggle pinned={state.pinned.has(node.id)} title={title} onToggle={onTogglePin} />
          <button
            ref={titleRef}
            type="button"
            className="graph-summary-title"
            aria-haspopup="dialog"
            onClick={onOpenPaper}
          >
            {title}
          </button>
          {range && (
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
          )}
          {!isUnresolved(node.selected_version) && (
            <button
              type="button"
              className="graph-icon-btn graph-view-btn"
              aria-label={t("paper.viewDetails")}
              title={t("paper.viewDetails")}
              onClick={onViewDetails}
            >
              <FileText size={15} aria-hidden="true" />
            </button>
          )}
        </div>
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
