import { Fragment, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { RangeControls, RangeItem, RangeSummary } from "@/components/graph/graphExploration";

export type RangeSelection = { index: number } | { last: true };

/** Only the first maxResults related papers are reachable. */
export function isRangeCapped(summary: RangeSummary): boolean {
  return summary.totalCapped || (summary.providerTotal ?? summary.total) > summary.maxResults;
}

/** "271–300 of 1,000", "… of about 1,000" or "… · first 10,000 of 52,340". */
export function rangeSummaryText(summary: RangeSummary, t: TFunction): string {
  const { start, end, total } = summary;
  if (isRangeCapped(summary)) {
    const providerTotal = summary.providerTotal ?? total;
    return t("graph.rangeOfCapped", { start, end, cap: summary.maxResults, total: providerTotal });
  }
  return t(summary.totalExact ? "graph.rangeOf" : "graph.rangeOfApprox", { start, end, total });
}

type NumericRange = Extract<RangeItem, { kind: "range" }>;

/** The ranges just before and after the current one, when they exist. */
export function adjacentRanges(controls: RangeControls): { previous: NumericRange | null; next: NumericRange | null } {
  const ranges = controls.items.filter((item): item is NumericRange => item.kind === "range");
  const current = ranges.find((item) => item.current);
  if (!controls.loaded || !current) return { previous: null, next: null };
  return {
    previous: ranges.find((item) => item.index === current.index - 1) ?? null,
    next: ranges.find((item) => item.index === current.index + 1) ?? null,
  };
}

interface RangeNavigatorProps {
  controls: RangeControls;
  onSelect: (selection: RangeSelection) => void;
}

/**
 * ‹ and › around the first, previous, current, next and last ranges of the
 * selected paper's related list, then "31–60 of 9,898 · ranked from
 * Semantic Scholar". Before the first load only 1–30 shows, current but not
 * loaded; tapping loads it. Buttons stay enabled: a newer tap aborts the
 * request in flight.
 */
export default function RangeNavigator({ controls, onSelect }: RangeNavigatorProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = useMemo(() => new Intl.NumberFormat(language), [language]);
  const { items, summary, pinsChanged } = controls;
  const { previous, next } = adjacentRanges(controls);
  const arrows = controls.loaded && items.length > 1;
  const capped = !!summary && isRangeCapped(summary);

  return (
    <div className="graph-ranges">
      {items.length > 0 && (
        <nav className="graph-range-nav" aria-label={t("graph.ranges")}>
          {arrows && (
            <button
              type="button"
              className="graph-range-btn graph-range-arrow"
              aria-label={t("graph.previousRange")}
              title={t("graph.previousRange")}
              disabled={!previous}
              onClick={() => previous && onSelect({ index: previous.index })}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
          )}
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
          {arrows && (
            <button
              type="button"
              className="graph-range-btn graph-range-arrow"
              aria-label={t("graph.nextRange")}
              title={t("graph.nextRange")}
              disabled={!next}
              onClick={() => next && onSelect({ index: next.index })}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          )}
        </nav>
      )}
      {summary && summary.total > 0 && (
        <p className="graph-range-summary">
          <span className="tabular">
            {rangeSummaryText(summary, t)}
            {!capped && <span className="graph-range-source"> · {t("graph.rankedFrom")}</span>}
          </span>
          <span className="graph-hint">{t("graph.totalsHint")}</span>
        </p>
      )}
      {pinsChanged && <p className="graph-hint">{t("graph.pinsChanged")}</p>}
    </div>
  );
}
