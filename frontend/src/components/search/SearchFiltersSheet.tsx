import { useId, useRef, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import DialogSurface from "@/components/ui/DialogSurface";
import SegmentedControl from "@/components/ui/SegmentedControl";
import YearFields, { type YearDrafts } from "@/components/search/YearFields";
import { YEAR_PRESETS, yearPresetLabel, type YearPreset } from "@/components/search/yearRange";
import type { PersonalFilters } from "@/components/search/SearchFilters";
import { SEARCH_SORTS } from "@/lib/searchParams";
import type { SearchSort } from "@/types";

interface Props {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement>;
  sortLabels: Record<SearchSort, string>;
  sort: SearchSort;
  onSortChange: (sort: SearchSort) => void;
  /** Shown under the sort when it narrows the matching. */
  sortHint: string | null;
  yearPreset: YearPreset;
  onPreset: (preset: Exclude<YearPreset, "custom">) => void;
  drafts: YearDrafts;
  onApplyYears: () => void;
  openAccess: boolean;
  onOpenAccessChange: (value: boolean) => void;
  personal?: PersonalFilters | null;
  canReset: boolean;
  onReset: () => void;
  /** Results the search shows (the provider's estimate); null while unknown. */
  resultCount: number | null;
  onShowResults: () => void;
}

/**
 * The phone Filters sheet (MobileFilters): sort, year presets and range,
 * and the toggles, ending in "Show N results". Toggles and presets apply at
 * once, like the desktop chips; typed years apply with Show results or Enter.
 */
export default function SearchFiltersSheet({
  onClose,
  returnFocusRef,
  sortLabels,
  sort,
  onSortChange,
  sortHint,
  yearPreset,
  onPreset,
  drafts,
  onApplyYears,
  openAccess,
  onOpenAccessChange,
  personal,
  canReset,
  onReset,
  resultCount,
  onShowResults,
}: Props) {
  const { t } = useTranslation();
  const id = useId();
  const titleId = `${id}-title`;
  const hintId = `${id}-sort-hint`;
  const fromRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Reset unmounts itself; the title keeps focus inside the sheet.
  const reset = () => {
    onReset();
    titleRef.current?.focus();
  };

  const submitYears = (event: FormEvent) => {
    event.preventDefault();
    onApplyYears();
  };

  const toggles: { label: string; checked: boolean; onChange: (value: boolean) => void }[] = [
    { label: t("search.openAccessOnly"), checked: openAccess, onChange: onOpenAccessChange },
  ];
  if (personal) {
    toggles.push(
      { label: t("search.unsavedOnly"), checked: personal.unsavedOnly, onChange: personal.onUnsavedOnlyChange },
      { label: t("search.hideDismissed"), checked: personal.hideDismissed, onChange: personal.onHideDismissedChange },
    );
  }

  return (
    <DialogSurface
      onClose={onClose}
      labelledBy={titleId}
      returnFocusRef={returnFocusRef}
      overlayClassName="panel-overlay"
      className="panel panel--bottom search-sheet"
      testId="search-filters-sheet"
    >
      <div className="panel-handle" aria-hidden="true" />
      <div className="panel-header search-sheet-header">
        <h2 ref={titleRef} id={titleId} className="panel-title search-sheet-title" tabIndex={-1}>
          {t("common.filters")}
        </h2>
        {canReset && (
          <button
            type="button"
            className="btn-quiet btn-quiet--accent"
            aria-label={t("common.resetFilters")}
            onClick={reset}
          >
            {t("search.reset")}
          </button>
        )}
        <button type="button" className="btn-ghost search-sheet-close" aria-label={t("common.close")} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="panel-body search-sheet-body">
        <p className="label-caps search-sheet-label" aria-hidden="true">
          {t("common.sortBy")}
        </p>
        <SegmentedControl
          block
          label={t("common.sortBy")}
          value={sort}
          options={SEARCH_SORTS.map((value) => ({ value, label: sortLabels[value] }))}
          onChange={onSortChange}
          describedBy={sortHint ? hintId : undefined}
        />
        {sortHint && (
          <p id={hintId} className="search-filters-hint">
            {sortHint}
          </p>
        )}

        <p className="label-caps search-sheet-label" id={`${id}-years`}>
          {t("search.yearRange")}
        </p>
        <div className="search-sheet-presets" role="group" aria-labelledby={`${id}-years`}>
          {YEAR_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="pill"
              aria-pressed={yearPreset === preset}
              onClick={() => (preset === "custom" ? fromRef.current?.focus() : onPreset(preset))}
            >
              {yearPresetLabel(preset, t, true)}
            </button>
          ))}
        </div>
        <form className="search-years" onSubmit={submitYears} noValidate>
          <YearFields id={`${id}-sheet`} drafts={drafts} fromRef={fromRef} />
        </form>

        <p className="label-caps search-sheet-label" id={`${id}-show`}>
          {t("search.showSection")}
        </p>
        <div className="search-sheet-toggles" role="group" aria-labelledby={`${id}-show`}>
          {toggles.map((toggle) => (
            <label key={toggle.label} className="search-sheet-toggle">
              <span>{toggle.label}</span>
              <input
                type="checkbox"
                checked={toggle.checked}
                onChange={(event) => toggle.onChange(event.target.checked)}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="search-sheet-footer">
        <button type="button" className="btn btn-primary sheet-submit" onClick={onShowResults}>
          {resultCount === null
            ? t("search.showResultsAny")
            : t("search.showResults", { count: resultCount })}
        </button>
      </div>
    </DialogSurface>
  );
}
