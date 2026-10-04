import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";

interface GraphLegendProps {
  /**
   * "overlay" is the pill floating at the canvas's bottom left (wide
   * screens), collapsible to a small chip. "inline" sits in the controls
   * sheet and adds the pinning hint.
   */
  variant?: "overlay" | "inline";
}

/**
 * Whether the overlay legend is open, remembered for the session in memory
 * only (Web Storage is reserved for theme and language): a reader who
 * collapses it keeps it collapsed on the next graph until a reload.
 */
let overlayOpen = true;

/**
 * The node marks (two fills, the Library's centre dot, the selection ring)
 * and the edge direction; inline also the pinning hint.
 */
export default function GraphLegend({ variant = "overlay" }: GraphLegendProps) {
  const { t } = useTranslation();
  const listId = useId();
  const [open, setOpen] = useState(overlayOpen);
  const inline = variant === "inline";

  const entries = (
    <>
      <li>
        <span className="legend-dot legend-dot--pinned" aria-hidden="true" /> {t("graph.legendPinned")}
      </li>
      <li>
        <span className="legend-dot" aria-hidden="true" /> {t("graph.legendPaper")}
      </li>
      <li>
        <span className="legend-dot legend-dot--saved" aria-hidden="true" /> {t("graph.legendSaved")}
      </li>
      <li>
        <span className="legend-dot legend-dot--selected" aria-hidden="true" /> {t("graph.legendSelected")}
      </li>
      <li>
        <svg className="legend-arrow" viewBox="0 0 22 10" aria-hidden="true" focusable="false">
          <line x1="1" y1="5" x2="15" y2="5" />
          <path d="M14 1.5 21 5 14 8.5Z" />
        </svg>{" "}
        {t("graph.legendEdge")}
      </li>
    </>
  );

  if (inline) {
    return (
      <ul className="graph-legend graph-legend--inline">
        {entries}
        <li className="legend-hint">{t("graph.dragHint")}</li>
      </ul>
    );
  }

  const toggle = () => {
    overlayOpen = !open;
    setOpen(overlayOpen);
  };

  // Collapsed, only the "Legend" chip is left on the canvas; open, its
  // caret turns to fold the entries back.
  return (
    <div className={`graph-legend-pill${open ? " graph-legend-pill--open" : ""}`}>
      <button
        type="button"
        className="graph-legend-toggle"
        aria-expanded={open}
        aria-controls={listId}
        title={open ? t("graph.legendHide") : undefined}
        onClick={toggle}
      >
        <span className={open ? "sr-only" : undefined}>{t("graph.legend")}</span>
        <ChevronRight size={14} className="graph-legend-caret" aria-hidden="true" />
      </button>
      <ul id={listId} className="graph-legend graph-legend--overlay" aria-label={t("graph.legend")} hidden={!open}>
        {entries}
      </ul>
    </div>
  );
}
