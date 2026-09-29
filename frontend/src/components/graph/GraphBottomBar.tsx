import { useTranslation } from "react-i18next";
import { DirectionToggle, OrderingToggle } from "@/components/graph/GraphControls";
import ExpandPinnedAction from "@/components/graph/ExpandPinnedAction";
import GraphStatus from "@/components/graph/GraphStatus";
import RangeNavigator, { type RangeSelection } from "@/components/graph/RangeNavigator";
import type { ExplorationState, RangeControls } from "@/components/graph/graphExploration";
import type { CitingOrder, RelationDirection } from "@/types";

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
}

/**
 * Desktop exploration bar below the canvas, always visible. Row A: what the
 * ranges refer to, pins, Direction and Order. Row B: the selected paper's
 * ranges, or "Expand pinned nodes" with nothing selected, plus live status.
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
}: GraphBottomBarProps) {
  const { t } = useTranslation();
  const { mode } = state;
  const source =
    selectedTitle === null
      ? t("graph.noSelection")
      : t(mode.direction === "cites" ? "graph.referencesOf" : "graph.citersOf", { title: selectedTitle });

  return (
    <div className="graph-bottombar" data-testid="graph-bottombar">
      <div className="graph-bar-row">
        <p className="graph-source">
          <span className="graph-source-text">{source}</span>
          <span className="graph-source-pins">{t("graph.pinnedCount", { count: state.pinned.size })}</span>
        </p>
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
          onCancelExpand={onCancelExpand}
        />
      </div>
    </div>
  );
}
