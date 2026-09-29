import { useTranslation } from "react-i18next";

interface GraphLegendProps {
  /** "overlay" floats on the canvas (desktop); "inline" sits in the controls sheet. */
  variant?: "overlay" | "inline";
}

function LegendItems() {
  const { t } = useTranslation();
  return (
    <ul className="graph-legend-body">
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
      <li>
        <span className="legend-line" aria-hidden="true" /> {t("graph.legendEdge")}
      </li>
      <li className="legend-hint">{t("graph.dragHint")}</li>
    </ul>
  );
}

/** Node colors, the selection ring, edges and the pinning hint. */
export default function GraphLegend({ variant = "overlay" }: GraphLegendProps) {
  const { t } = useTranslation();
  if (variant === "inline") {
    return (
      <div className="graph-legend graph-legend--inline">
        <LegendItems />
      </div>
    );
  }
  return (
    <details className="graph-legend graph-legend--overlay">
      <summary>{t("graph.legend")}</summary>
      <LegendItems />
    </details>
  );
}
