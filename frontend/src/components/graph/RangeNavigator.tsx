import { Fragment, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { RangeControls, RangeSummary } from "@/components/graph/graphExploration";

export type RangeSelection = { index: number } | { last: true };

/** "271–300 of 1,000", "… of about 1,000" or "… · first 10,000 of 52,340". */
export function rangeSummaryText(summary: RangeSummary, t: TFunction): string {
  const { start, end, total } = summary;
  const providerTotal = summary.providerTotal ?? total;
  if (summary.totalCapped || providerTotal > summary.maxResults) {
    return t("graph.rangeOfCapped", { start, end, cap: summary.maxResults, total: providerTotal });
  }
  return t(summary.totalExact ? "graph.rangeOf" : "graph.rangeOfApprox", { start, end, total });
}

interface RangeNavigatorProps {
  controls: RangeControls;
  onSelect: (selection: RangeSelection) => void;
}

/**
 * First, previous, current, next and last ranges of the selected paper's
 * related list. Before the first load only 1–30 shows, current but not
 * loaded; tapping loads it. Buttons stay enabled: a newer tap aborts the
 * request in flight.
 */
export default function RangeNavigator({ controls, onSelect }: RangeNavigatorProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = useMemo(() => new Intl.NumberFormat(language), [language]);
  const { items, summary, pinsChanged } = controls;

  return (
    <div className="graph-ranges">
      {items.length > 0 && (
        <nav className="graph-range-nav" aria-label={t("graph.ranges")}>
          {items.map((item) => (
            <Fragment key={item.kind === "last" ? "last" : item.index}>
              {item.gapBefore && (
                <span className="graph-range-gap" aria-hidden="true">
                  …
                </span>
              )}
              {item.kind === "last" ? (
                <button
                  type="button"
                  className="graph-range-btn"
                  aria-label={t("graph.rangeLastUnknown")}
                  onClick={() => onSelect({ last: true })}
                >
                  {t("graph.rangeLast")}
                </button>
              ) : (
                <button
                  type="button"
                  className={`graph-range-btn${item.current ? " is-current" : ""}${item.loaded ? "" : " is-unloaded"}`}
                  aria-current={item.current ? "true" : undefined}
                  aria-label={item.loaded ? t("graph.showRange", { start: item.start, end: item.end }) : undefined}
                  onClick={() => onSelect({ index: item.index })}
                >
                  <span aria-hidden={item.loaded ? undefined : "true"}>
                    {number.format(item.start)}–{number.format(item.end)}
                  </span>
                  {!item.loaded && (
                    <span className="sr-only">{t("graph.rangeNotLoaded", { start: item.start, end: item.end })}</span>
                  )}
                </button>
              )}
            </Fragment>
          ))}
        </nav>
      )}
      {summary && summary.total > 0 && (
        <p className="graph-range-summary">
          <span>{rangeSummaryText(summary, t)}</span>
          <span className="graph-hint">{t("graph.totalsHint")}</span>
        </p>
      )}
      {pinsChanged && <p className="graph-hint">{t("graph.pinsChanged")}</p>}
    </div>
  );
}
