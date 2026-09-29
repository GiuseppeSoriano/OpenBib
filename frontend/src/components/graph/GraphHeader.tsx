import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, List, Maximize2, SlidersHorizontal, ZoomIn, ZoomOut } from "lucide-react";

export type GraphHeaderMode = "paper" | "collection" | "library";

interface GraphHeaderProps {
  mode: GraphHeaderMode;
  /** Paper mode: the seed's display title, after "Citation graph". */
  seedTitle: string | null;
  hasGraph: boolean;
  nodeCount: number;
  edgeCount: number;
  pinnedCount: number;
  /** Compact presentation: Fit plus the "Graph controls" sheet trigger. */
  compact: boolean;
  onBack: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  papersOpen: boolean;
  papersListId: string;
  onTogglePapers: () => void;
  controlsOpen?: boolean;
  controlsTriggerRef?: Ref<HTMLButtonElement>;
  onOpenControls?: () => void;
}

/**
 * One header row that takes real space above the canvas: back, the page
 * `<h1>`, the mode badge, counts and pins, then the view controls. A
 * container query hides the badge and counts as the row narrows.
 */
export default function GraphHeader({
  mode,
  seedTitle,
  hasGraph,
  nodeCount,
  edgeCount,
  pinnedCount,
  compact,
  onBack,
  onZoomIn,
  onZoomOut,
  onFit,
  papersOpen,
  papersListId,
  onTogglePapers,
  controlsOpen = false,
  controlsTriggerRef,
  onOpenControls,
}: GraphHeaderProps) {
  const { t } = useTranslation();
  const modeLabel =
    mode === "paper" ? t("graph.modePaper") : mode === "collection" ? t("graph.modeCollection") : t("graph.modeLibrary");

  return (
    <div className="graph-header" data-testid="graph-header">
      <div className="graph-header-row">
        <button
          type="button"
          className="btn-ghost graph-icon-btn graph-back"
          onClick={onBack}
          aria-label={t("graph.back")}
          title={t("graph.back")}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <h1 className="graph-title">
          <span className="graph-title-main">{t("graph.title")}</span>
          {seedTitle && (
            <span className="graph-title-seed">
              <span className="sr-only">: </span>
              {seedTitle}
            </span>
          )}
        </h1>
        <span className="graph-mode-badge">{modeLabel}</span>
        {hasGraph && (
          <span className="graph-counts">
            {t("graph.nodeCount", { count: nodeCount })} · {t("graph.edgeCount", { count: edgeCount })}
          </span>
        )}
        {hasGraph && <span className="badge graph-pinned-badge">{t("graph.pinnedCount", { count: pinnedCount })}</span>}
        {hasGraph && (
          <div className="graph-header-actions">
            {!compact && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary graph-btn"
                  aria-expanded={papersOpen}
                  aria-controls={papersOpen ? papersListId : undefined}
                  onClick={onTogglePapers}
                >
                  <List size={15} aria-hidden="true" />
                  {t("graph.papers", { count: nodeCount })}
                </button>
                <button type="button" className="graph-icon-btn graph-view-btn" onClick={onZoomIn} aria-label={t("graph.zoomIn")} title={t("graph.zoomIn")}>
                  <ZoomIn size={15} aria-hidden="true" />
                </button>
                <button type="button" className="graph-icon-btn graph-view-btn" onClick={onZoomOut} aria-label={t("graph.zoomOut")} title={t("graph.zoomOut")}>
                  <ZoomOut size={15} aria-hidden="true" />
                </button>
              </>
            )}
            <button type="button" className="graph-icon-btn graph-view-btn" onClick={onFit} aria-label={t("graph.fit")} title={t("graph.fit")}>
              <Maximize2 size={15} aria-hidden="true" />
            </button>
            {compact && (
              <button
                ref={controlsTriggerRef}
                type="button"
                className="btn btn-secondary graph-btn graph-controls-trigger"
                aria-haspopup="dialog"
                aria-expanded={controlsOpen}
                aria-label={t("graph.controls")}
                onClick={onOpenControls}
              >
                <SlidersHorizontal size={15} aria-hidden="true" />
                <span className="graph-controls-label">{t("graph.controls")}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
