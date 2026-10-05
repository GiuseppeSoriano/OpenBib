import { useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ZoomIn, ZoomOut } from "lucide-react";
import ExpandPinnedAction from "@/components/graph/ExpandPinnedAction";
import { RelationSource } from "@/components/graph/GraphBottomBar";
import { DirectionToggle, OrderingToggle } from "@/components/graph/GraphControls";
import GraphLegend from "@/components/graph/GraphLegend";
import GraphNodePopup from "@/components/graph/GraphNodePopup";
import RangeNavigator, { type RangeSelection } from "@/components/graph/RangeNavigator";
import { paperTitle } from "@/components/graph/paperText";
import type { ExplorationState, RangeControls } from "@/components/graph/graphExploration";
import Panel from "@/components/ui/Panel";
import type { CitingOrder, GraphNode, PaperMetadata, RelationDirection } from "@/types";

export type GraphSheetTab = "controls" | "papers";

const TABS: GraphSheetTab[] = ["controls", "papers"];

interface GraphControlsSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * "bottom" on phones; "auto" on short landscape screens, a right sheet
   * (graph.css keeps it one below 768px, where Panel would turn to the bottom).
   */
  placement: "auto" | "bottom";
  returnFocusRef: RefObject<HTMLElement>;
  tab: GraphSheetTab;
  onTabChange: (tab: GraphSheetTab) => void;
  papersCount: number;
  controls: ReactNode;
  papers: ReactNode;
  /** Set to an element inside the open sheet: `closest(".panel")` is the sheet itself. */
  contentRef?: RefObject<HTMLDivElement>;
}

/**
 * Compact "Graph controls" sheet: a Controls tab (selected paper, direction,
 * order, ranges or Expand pinned, view, legend) and a Papers tab. Its state
 * lives with the page, so reopening keeps every choice.
 */
export default function GraphControlsSheet({
  open,
  onClose,
  placement,
  returnFocusRef,
  tab,
  onTabChange,
  papersCount,
  controls,
  papers,
  contentRef,
}: GraphControlsSheetProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const tabRefs = useRef<Partial<Record<GraphSheetTab, HTMLButtonElement | null>>>({});
  const labels: Record<GraphSheetTab, string> = {
    controls: t("graph.controlsTab"),
    papers: t("graph.papers", { count: papersCount }),
  };

  // Automatic activation: arrow keys, Home and End move focus and select.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[next]!;
    onTabChange(target);
    tabRefs.current[target]?.focus();
  };

  return (
    <Panel
      open={open}
      onClose={onClose}
      title={t("graph.controls")}
      placement={placement}
      returnFocusRef={returnFocusRef}
      testId="graph-controls-sheet"
    >
      <div ref={contentRef} className="graph-sheet-tabs" role="tablist" aria-label={t("graph.controls")} onKeyDown={onKeyDown}>
        {TABS.map((key) => (
          <button
            key={key}
            ref={(element) => {
              tabRefs.current[key] = element;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${key}`}
            className="graph-sheet-tab"
            aria-selected={tab === key}
            aria-controls={tab === key ? `${baseId}-panel-${key}` : undefined}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => onTabChange(key)}
          >
            {labels[key]}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${tab}`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        className="graph-sheet-panel"
      >
        {tab === "controls" ? controls : papers}
      </div>
      <div className="graph-sheet-footer">
        <button type="button" className="btn btn-primary sheet-submit" onClick={onClose}>
          {t("common.done")}
        </button>
      </div>
    </Panel>
  );
}

interface GraphSheetControlsProps {
  state: ExplorationState;
  node: GraphNode | null;
  rangeControls: RangeControls | null;
  onTogglePin: () => void;
  onSelectVersion: (version: PaperMetadata) => void;
  onViewDetails: () => void;
  /** Loads the selected paper's first range (closes the sheet). */
  onExplore?: () => void;
  onDirection: (direction: RelationDirection) => void;
  onOrder: (order: CitingOrder) => void;
  onRange: (selection: RangeSelection) => void;
  onExpand: () => void;
  onConfirmExpand: () => void;
  onCancelExpand: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

/**
 * The sheet's Controls tab: the selected paper's card, Direction and Order
 * (applied at once), its ranges or "Expand pinned nodes", zoom and legend.
 */
export function GraphSheetControls({
  state,
  node,
  rangeControls,
  onTogglePin,
  onSelectVersion,
  onViewDetails,
  onExplore,
  onDirection,
  onOrder,
  onRange,
  onExpand,
  onConfirmExpand,
  onCancelExpand,
  onZoomIn,
  onZoomOut,
}: GraphSheetControlsProps) {
  const { t } = useTranslation();
  const viewId = useId();
  const { mode } = state;

  return (
    <>
      {node && (
        <div className="graph-sheet-section">
          <p className="graph-sheet-label label-caps">{t("graph.selectedPaper")}</p>
          <GraphNodePopup
            node={node}
            pinned={state.pinned.has(node.id)}
            variant="sheet"
            onTogglePin={onTogglePin}
            onSelectVersion={onSelectVersion}
            onViewDetails={onViewDetails}
            onExplore={onExplore}
          />
        </div>
      )}
      <div className="graph-sheet-section">
        <RelationSource direction={mode.direction} title={node ? paperTitle(node.selected_version, t) : null} />
        <p className="graph-hint tabular">{t("graph.pinnedCount", { count: state.pinned.size })}</p>
        <div className="graph-sheet-field">
          <span className="graph-sheet-label label-caps" aria-hidden="true">
            {t("graph.direction")}
          </span>
          <DirectionToggle value={mode.direction} onChange={onDirection} block />
        </div>
        <div className="graph-sheet-field">
          <span className="graph-sheet-label label-caps" aria-hidden="true">
            {t("graph.ordering")}
          </span>
          <OrderingToggle value={mode.order} onChange={onOrder} block />
        </div>
        {node && rangeControls ? (
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
      </div>
      <div className="graph-sheet-section" role="group" aria-labelledby={viewId}>
        <p id={viewId} className="graph-sheet-label label-caps">
          {t("graph.view")}
        </p>
        <div className="graph-sheet-view">
          <button type="button" className="btn btn-secondary graph-btn" onClick={onZoomIn}>
            <ZoomIn size={15} aria-hidden="true" />
            {t("graph.zoomIn")}
          </button>
          <button type="button" className="btn btn-secondary graph-btn" onClick={onZoomOut}>
            <ZoomOut size={15} aria-hidden="true" />
            {t("graph.zoomOut")}
          </button>
        </div>
      </div>
      <div className="graph-sheet-section">
        <p className="graph-sheet-label label-caps">{t("graph.legend")}</p>
        <GraphLegend variant="inline" />
      </div>
    </>
  );
}
