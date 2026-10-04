import { useTranslation } from "react-i18next";

interface GraphLegendProps {
  /**
   * "overlay" is the pill floating at the canvas's bottom left (wide
   * screens): node colours and the selection ring. "inline" sits in the
   * controls sheet and adds the edge direction and the pinning hint.
   */
  variant?: "overlay" | "inline";
}

/** Node colours, the selection ring, and inline also edges and the pinning hint. */
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
        <span className="legend-dot legend-dot--selected" aria-hidden="true" /> {t("graph.legendSelected")}
      </li>
      <li>
        <span className="legend-dot legend-dot--saved" aria-hidden="true" /> {t("graph.legendSaved")}
      </li>
      <li>
        <span className="legend-dot" aria-hidden="true" /> {t("graph.legendPaper")}
      </li>
      {inline && (
        <>
          <li>
            <span className="legend-line" aria-hidden="true" /> {t("graph.legendEdge")}
          </li>
          <li className="legend-hint">{t("graph.dragHint")}</li>
        </>
      )}
    </ul>
  );
}
