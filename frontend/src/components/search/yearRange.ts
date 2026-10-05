import type { TFunction } from "i18next";
import type { SearchParamsState } from "@/lib/searchParams";

export type YearPatch = Pick<SearchParamsState, "year_from" | "year_to">;

/** Year presets of the Year popover and the mobile Filters sheet. */
export type YearPreset = "any" | "since" | "last5" | "custom";

export const YEAR_PRESETS: readonly YearPreset[] = ["any", "since", "last5", "custom"];

/** The current year as the API counts it (UTC). */
function currentYear(now: Date): number {
  return now.getUTCFullYear();
}

/** The years a preset applies; null for "custom", which is typed instead. */
export function presetYears(preset: YearPreset, now: Date = new Date()): YearPatch | null {
  const year = currentYear(now);
  switch (preset) {
    case "any":
      return { year_from: undefined, year_to: undefined };
    case "since":
      return { year_from: year, year_to: undefined };
    case "last5":
      return { year_from: year - 4, year_to: undefined };
    default:
      return null;
  }
}

/** The preset matching the applied years ("custom" for any other range). */
export function activeYearPreset(params: YearPatch, now: Date = new Date()): YearPreset {
  const { year_from: from, year_to: to } = params;
  if (from === undefined && to === undefined) return "any";
  if (to !== undefined) return "custom";
  const year = currentYear(now);
  if (from === year) return "since";
  if (from === year - 4) return "last5";
  return "custom";
}

/** Labels of the presets; "since" names the current year. */
export function yearPresetLabel(preset: YearPreset, t: TFunction, compact = false, now: Date = new Date()): string {
  switch (preset) {
    case "any":
      return t("search.anyTime");
    case "since":
      return t("search.yearSince", { year: currentYear(now) });
    case "last5":
      return t("search.lastFiveYears");
    default:
      return t(compact ? "search.custom" : "search.customRange");
  }
}

/** "2019–2023", "Since 2019", "Until 2020", or null without a range. */
export function yearRangeText(params: YearPatch, t: TFunction): string | null {
  const { year_from: from, year_to: to } = params;
  if (from !== undefined && to !== undefined) {
    return from === to ? String(from) : t("search.yearBetween", { from, to });
  }
  if (from !== undefined) return t("search.yearSince", { year: from });
  if (to !== undefined) return t("search.yearUntil", { year: to });
  return null;
}
