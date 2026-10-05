import { useTranslation } from "react-i18next";
import { DirectionToggle, OrderingToggle } from "@/components/graph/GraphControls";
import ExpandPinnedAction from "@/components/graph/ExpandPinnedAction";
import GraphStatus from "@/components/graph/GraphStatus";
import RangeNavigator, { type RangeSelection } from "@/components/graph/RangeNavigator";
import type { ExplorationState, RangeControls } from "@/components/graph/graphExploration";
import type { CitingOrder, RelationDirection } from "@/types";

/** Stands in for the title while the sentence is translated, then is split on. */
const TITLE_MARK = "\u0000";

/**
 * What the ranges refer to: "Citers of <cite>Title</cite>" (the title set
 * in italic serif), or the hint to select a paper.
 */
export function RelationSource({
  direction,
  title,
  className = "graph-source",
}: {
  direction: RelationDirection;
  title: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  if (title === null) {
    return (
      <p className={className}>
        <span className="graph-source-text">{t("graph.noSelection")}</span>
      </p>
    );
  }
  const sentence = t(direction === "cites" ? "graph.referencesOf" : "graph.citersOf", { title: TITLE_MARK });
  const at = sentence.indexOf(TITLE_MARK);
  const before = at < 0 ? sentence : sentence.slice(0, at);
  const after = at < 0 ? "" : sentence.slice(at + TITLE_MARK.length);
  return (
    <p className={className}>
      <span className="graph-source-text">
        {before}
        <cite className="graph-source-title">{title}</cite>
        {after}
      </span>
    </p>
  );
}

interface GraphBottomBarProps {
  state: ExplorationState;
  /** Display title of the selected paper, if any. */
  selectedTitle: string | null;
  rangeControls: RangeControls | null;
  onDirection: (direction: RelationDirection) => void;
  onOrder: (order: CitingOrder) => void;
  onRange: (selection: RangeSelection) => void;
  onExpand: () => void;
  onConfirmExpand: () => void;
  onCancelExpand: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  onContinueRanking: () => void;
}

/**
 * Desktop exploration bar below the canvas, always visible. Row A: what the
 * ranges refer to, Direction and Order. Row B: the selected paper's ranges,
 * or "Expand pinned nodes" with nothing selected, plus live status.
 */
export default function GraphBottomBar({
  state,
  selectedTitle,
  rangeControls,
  onDirection,
  onOrder,
  onRange,
  onExpand,
  onConfirmExpand,
  onCancelExpand,
  onRetry,
  onDismiss,
  onContinueRanking,
}: GraphBottomBarProps) {
  const { mode } = state;

  return (
    <div className="graph-bottombar" data-testid="graph-bottombar">
      <div className="graph-bar-row">
        <RelationSource direction={mode.direction} title={selectedTitle} />
        <div className="graph-bar-toggles">
          <DirectionToggle value={mode.direction} onChange={onDirection} />
          <OrderingToggle value={mode.order} onChange={onOrder} />
        </div>
      </div>
      <div className="graph-bar-row">
        {selectedTitle !== null && rangeControls ? (
          <RangeNavigator controls={rangeControls} onSelect={onRange} />
        ) : (
          <ExpandPinnedAction
            pinnedCount={state.pinned.size}
            run={state.expand}
            target={state.rangeSize}
            onExpand={onExpand}
            onConfirm={onConfirmExpand}
            onCancel={onCancelExpand}
          />
        )}
        <GraphStatus
          state={state}
          showExpandProgress={selectedTitle !== null}
          onRetry={onRetry}
          onDismiss={onDismiss}
          onContinueRanking={onContinueRanking}
          onCancelExpand={onCancelExpand}
        />
      </div>
    </div>
  );
}
