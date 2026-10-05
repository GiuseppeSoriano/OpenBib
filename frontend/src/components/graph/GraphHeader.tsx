import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, List, Maximize, Minus, Plus, SlidersHorizontal } from "lucide-react";
import HomeLink from "@/components/shell/HomeLink";

interface GraphHeaderProps {
  /** The serif title under the "Citation graph" label: the seed, collection or library. */
  title: string | null;
  hasGraph: boolean;
  nodeCount: number;
  edgeCount: number;
  pinnedCount: number;
  /** Compact presentation: Fit plus the "Graph controls" sheet trigger. */
  compact: boolean;
  onBack?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFit?: () => void;
  papersOpen?: boolean;
  papersListId?: string;
  /** The Papers button, where focus returns when the panel closes itself. */
  papersTriggerRef?: Ref<HTMLButtonElement>;
  onTogglePapers?: () => void;
  controlsOpen?: boolean;
  controlsTriggerRef?: Ref<HTMLButtonElement>;
  onOpenControls?: () => void;
}

/**
 * The graph page's own header (no app shell here): the OpenBib mark home,
 * Back, a small "Citation graph" label over the serif title (one `<h1>`),
 * the counts, then the view controls. Narrow (container queries in em, so
 * large text counts too), the counts fold into the label line and the
 * controls wrap below the title.
 */
export default function GraphHeader({
  title,
  hasGraph,
  nodeCount,
  edgeCount,
  pinnedCount,
  compact,
  onBack,
  onZoomIn,
  onZoomOut,
  onFit,
  papersOpen = false,
  papersListId,
  papersTriggerRef,
  onTogglePapers,
  controlsOpen = false,
  controlsTriggerRef,
  onOpenControls,
}: GraphHeaderProps) {
  const { t } = useTranslation();
  const pinned = t("graph.pinnedCount", { count: pinnedCount });

  return (
    <header className={`graph-header${compact ? " graph-header--compact" : ""}`} data-testid="graph-header">
      <div className="graph-header-row">
        <HomeLink className="graph-home" />
        {onBack && (
          <button
            type="button"
            className="graph-icon-btn graph-view-btn graph-back"
            onClick={onBack}
            aria-label={t("graph.back")}
            title={t("graph.back")}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
        )}
        <h1 className={title ? "graph-title graph-title--seeded" : "graph-title"}>
          <span className="graph-title-main">
            {t("graph.title")}
            {/* Narrow headers show the pins in this line; the counts below say it to assistive tech. */}
            {hasGraph && (
              <span className="graph-title-pins tabular" aria-hidden="true">
                {` · ${pinned}`}
              </span>
            )}
          </span>
          {title && (
            <span className="graph-title-seed">
              <span className="sr-only">: </span>
              {title}
            </span>
          )}
        </h1>
        {hasGraph && (
          <p className="graph-counts tabular">
            <span>
              {t("graph.nodeCount", { count: nodeCount })} · {t("graph.edgeCount", { count: edgeCount })}
            </span>
            <span className="graph-counts-pins">
              <span aria-hidden="true"> · </span>
              {pinned}
            </span>
          </p>
        )}
        {hasGraph && (
          <div className="graph-header-actions">
            {!compact && (
              <>
                <button
                  ref={papersTriggerRef}
                  type="button"
                  className="graph-view-btn graph-papers-btn"
                  aria-expanded={papersOpen}
                  aria-controls={papersOpen ? papersListId : undefined}
                  onClick={onTogglePapers}
                >
                  <List size={15} aria-hidden="true" />
                  {t("graph.papersToggle")}
                </button>
                <button type="button" className="graph-icon-btn graph-view-btn" onClick={onZoomIn} aria-label={t("graph.zoomIn")} title={t("graph.zoomIn")}>
                  <Plus size={16} aria-hidden="true" />
                </button>
                <button type="button" className="graph-icon-btn graph-view-btn" onClick={onZoomOut} aria-label={t("graph.zoomOut")} title={t("graph.zoomOut")}>
                  <Minus size={16} aria-hidden="true" />
                </button>
              </>
            )}
            <button type="button" className="graph-icon-btn graph-view-btn" onClick={onFit} aria-label={t("graph.fit")} title={t("graph.fit")}>
              <Maximize size={15} aria-hidden="true" />
            </button>
            {compact && (
              <button
                ref={controlsTriggerRef}
                type="button"
                className="graph-view-btn graph-controls-trigger"
                aria-haspopup="dialog"
                aria-expanded={controlsOpen}
                aria-label={t("graph.controls")}
                onClick={onOpenControls}
              >
                <SlidersHorizontal size={16} aria-hidden="true" />
                <span className="graph-controls-label">{t("graph.controls")}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
