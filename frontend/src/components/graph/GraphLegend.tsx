import { useTranslation } from "react-i18next";

interface GraphLegendProps {
  /**
   * "overlay" is the pill floating at the canvas's bottom left (wide
   * screens). "inline" sits in the controls sheet and adds the pinning hint.
   */
  variant?: "overlay" | "inline";
}

/**
 * The node marks (two fills, the Library's centre dot, the selection ring)
 * and the edge direction; inline also the pinning hint.
 */
export default function GraphLegend({ variant = "overlay" }: GraphLegendProps) {
  const { t } = useTranslation();
  const inline = variant === "inline";
  return (
    <ul
      className={`graph-legend graph-legend--${variant}`}
      aria-label={inline ? undefined : t("graph.legend")}
    >
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
      {inline && <li className="legend-hint">{t("graph.dragHint")}</li>}
    </ul>
  );
}
