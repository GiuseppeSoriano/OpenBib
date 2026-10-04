import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal } from "lucide-react";
import { COMPACT_QUERY } from "@/lib/breakpoints";
import {
  activeFilterCount,
  DEFAULT_SEARCH_SORT,
  SEARCH_SORTS,
  type SearchParamsState,
} from "@/lib/searchParams";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import Popover, { PopoverListbox } from "@/components/ui/Popover";
import { Chip, FilterChip, MenuChip } from "@/components/ui/Chip";
import YearFields, { useYearDrafts } from "@/components/search/YearFields";
import SearchFiltersSheet from "@/components/search/SearchFiltersSheet";
import {
  activeYearPreset,
  presetYears,
  YEAR_PRESETS,
  yearPresetLabel,
  yearRangeText,
  type YearPatch,
  type YearPreset,
} from "@/components/search/yearRange";
import type { SearchSort } from "@/types";
import "./SearchFilters.css";

export const SORT_LABELS: Record<SearchSort, string> = {
  relevance: "search.sortRelevance",
  date: "search.sortNewest",
  citations: "search.sortMostCited",
};

type FilterPatch = Partial<Omit<SearchParamsState, "q">>;

/** Signed-in filters applied to the loaded results (not kept in the URL). */
export interface PersonalFilters {
  unsavedOnly: boolean;
  hideDismissed: boolean;
  onUnsavedOnlyChange: (value: boolean) => void;
  onHideDismissedChange: (value: boolean) => void;
}

export interface SearchFiltersHandle {
  /**
   * Years typed but not applied yet, for a search submitted from outside:
   * `{}` when there are none, null (with the error shown) when invalid.
   */
  pendingYears: () => YearPatch | null;
}

interface Props {
  /** The applied search (from the URL). */
  params: SearchParamsState;
  onChange: (patch: FilterPatch) => void;
  onReset: () => void;
  /** Not in a collection and Hide dismissed; omitted for visitors. */
  personal?: PersonalFilters | null;
  /** The personal filters differ from their defaults (Reset restores them). */
  personalActive?: boolean;
  /** Results of the current search, for the phone sheet's button; null while unknown. */
  resultCount?: number | null;
}

/** Idle time before a sort change in the sheet applies, so arrowing through it runs one search. */
const SORT_DELAY_MS = 400;

/**
 * The Search toolbar. Desktop: one row of chips (Year popover, Open access,
 * the personal toggles, Sort listbox, Reset). Phones and short landscape
 * screens: a scrolling chip row (Filters · N and the active filters) and the
 * Filters sheet. The applied values live in the URL (see lib/searchParams):
 * toggles and presets apply at once, typed years with Apply (or Enter) or
 * with the next search.
 */
const SearchFilters = forwardRef<SearchFiltersHandle, Props>(function SearchFilters(
  { params, onChange, onReset, personal = null, personalActive = false, resultCount = null },
  ref,
) {
  const { t } = useTranslation();
  const id = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const [yearOpen, setYearOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetTriggerRef = useRef<HTMLButtonElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const presetRef = useRef<HTMLButtonElement>(null);

  // Invalid typed years open the surface that shows the error.
  const drafts = useYearDrafts(params, () => (compact ? setSheetOpen(true) : setYearOpen(true)));
  useImperativeHandle(ref, () => ({ pendingYears: drafts.pending }));

  // The year popover focuses the From field while it shows an error, the
  // current preset otherwise; one stable ref so focus moves only on open.
  const yearErrorRef = useRef(false);
  yearErrorRef.current = !!drafts.error;
  const yearFocusRef = useMemo(
    () =>
      ({
        get current() {
          return yearErrorRef.current ? fromRef.current : presetRef.current;
        },
      }) as RefObject<HTMLElement>,
    [],
  );

  /** A toggle or sort change also applies valid typed years. */
  const applyWith = (patch: FilterPatch) => onChange({ ...drafts.pending(), ...patch });

  /** Applies the typed years; false (with the error shown) when invalid. */
  const applyYears = (): boolean => {
    const years = drafts.read();
    if (years) onChange(years);
    return years !== null;
  };

  const applyPreset = (preset: Exclude<YearPreset, "custom">) => {
    const years = presetYears(preset);
    if (!years) return;
    drafts.set(years);
    onChange(years);
  };

  // The sheet's segmented sort selects on every arrow key: the choice
  // applies once it settles, or when the sheet closes.
  const [pendingSort, setPendingSort] = useState<SearchSort | null>(null);
  const sortTimer = useRef<number | undefined>(undefined);
  const appliedSort = params.sort ?? DEFAULT_SEARCH_SORT;
  const sort = pendingSort ?? appliedSort;
  const applySort = () => {
    window.clearTimeout(sortTimer.current);
    sortTimer.current = undefined;
    if (pendingSort === null) return;
    setPendingSort(null);
    applyWith({ sort: pendingSort });
  };
  // The timer runs the latest applySort, with the latest drafts and search.
  const applySortRef = useRef(applySort);
  useEffect(() => {
    applySortRef.current = applySort;
  });
  useEffect(() => () => window.clearTimeout(sortTimer.current), []);
  const changeSort = (value: SearchSort) => {
    setPendingSort(value);
    window.clearTimeout(sortTimer.current);
    sortTimer.current = window.setTimeout(() => applySortRef.current(), SORT_DELAY_MS);
  };

  const closeSheet = () => {
    applySort();
    setSheetOpen(false);
  };

  /** "Show N results": applies typed years and a settling sort, then closes. */
  const showResults = () => {
    const years = drafts.pending();
    if (years === null) return;
    window.clearTimeout(sortTimer.current);
    const patch: FilterPatch = { ...years };
    if (pendingSort !== null) patch.sort = pendingSort;
    setPendingSort(null);
    if (Object.keys(patch).length > 0) onChange(patch);
    setSheetOpen(false);
  };

  const yearsText = yearRangeText(params, t);
  const preset: YearPreset = drafts.dirty ? "custom" : activeYearPreset(params);
  const sortOptions = SEARCH_SORTS.map((value) => ({ value, label: t(SORT_LABELS[value]) }));
  const sortLabels = Object.fromEntries(sortOptions.map((option) => [option.value, option.label])) as Record<
    SearchSort,
    string
  >;
  const filterCount = activeFilterCount(params) + (appliedSort !== DEFAULT_SEARCH_SORT ? 1 : 0);
  const canReset = activeFilterCount(params) > 0 || personalActive;
  const hintId = `${id}-sort-hint`;
  const sortHint = sort !== DEFAULT_SEARCH_SORT ? t("search.sortAllWordsHint") : null;

  const personalChips = personal && (
    <>
      <FilterChip pressed={personal.unsavedOnly} onPressedChange={personal.onUnsavedOnlyChange}>
        {t("search.unsavedOnly")}
      </FilterChip>
      <FilterChip pressed={personal.hideDismissed} onPressedChange={personal.onHideDismissedChange}>
        {t("search.hideDismissed")}
      </FilterChip>
    </>
  );
  const openAccessChip = (
    <FilterChip pressed={!!params.oa} onPressedChange={(value) => applyWith({ oa: value || undefined })}>
      {t("search.openAccess")}
    </FilterChip>
  );
  const hint = sortHint && (
    <p id={hintId} className="search-filters-hint">
      {sortHint}
    </p>
  );

  if (compact) {
    /** A removed filter chip unmounts: focus goes back to the Filters button. */
    const removeThen = (patch: FilterPatch) => {
      applyWith(patch);
      sheetTriggerRef.current?.focus();
    };
    const restoreThen = (restore: () => void) => {
      restore();
      sheetTriggerRef.current?.focus();
    };
    // The personal toggles live in the sheet; the row names them only when
    // they differ from their defaults, like the other active filters.
    const unsavedShown = !!personal?.unsavedOnly;
    const dismissedShown = !!personal && !personal.hideDismissed;
    const rowCount = filterCount + (unsavedShown ? 1 : 0) + (dismissedShown ? 1 : 0);
    return (
      <section className="search-filters search-filters--compact" aria-label={t("common.filters")}>
        <div className="chip-row chip-row--scroll search-filters-row">
          <button
            ref={sheetTriggerRef}
            type="button"
            className={`chip${rowCount > 0 ? " chip--active" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
          >
            <SlidersHorizontal size={15} aria-hidden="true" />
            {t("common.filters")}
            {rowCount > 0 && (
              <>
                <span className="chip-count" aria-hidden="true">
                  · {rowCount}
                </span>
                <span className="sr-only">{t("common.filtersActive", { count: rowCount })}</span>
              </>
            )}
          </button>
          {yearsText && (
            <Chip
              active
              removeLabel={t("search.removeFilter", { filter: yearsText })}
              onRemove={() => removeThen({ year_from: undefined, year_to: undefined })}
            >
              {yearsText}
            </Chip>
          )}
          {appliedSort !== DEFAULT_SEARCH_SORT && (
            <Chip
              active
              removeLabel={t("search.removeFilter", { filter: sortLabels[appliedSort] })}
              onRemove={() => removeThen({ sort: undefined })}
            >
              {sortLabels[appliedSort]}
            </Chip>
          )}
          {openAccessChip}
          {personal && unsavedShown && (
            <Chip
              active
              removeLabel={t("search.removeFilter", { filter: t("search.unsavedOnly") })}
              onRemove={() => restoreThen(() => personal.onUnsavedOnlyChange(false))}
            >
              {t("search.unsavedOnly")}
            </Chip>
          )}
          {personal && dismissedShown && (
            <Chip
              active
              removeLabel={t("search.removeFilter", { filter: t("search.dismissedShown") })}
              onRemove={() => restoreThen(() => personal.onHideDismissedChange(true))}
            >
              {t("search.dismissedShown")}
            </Chip>
          )}
        </div>
        {!sheetOpen && hint}
        {sheetOpen && (
          <SearchFiltersSheet
            onClose={closeSheet}
            returnFocusRef={sheetTriggerRef}
            sortLabels={sortLabels}
            sort={sort}
            onSortChange={changeSort}
            sortHint={sortHint}
            yearPreset={preset}
            onPreset={applyPreset}
            drafts={drafts}
            onApplyYears={applyYears}
            openAccess={!!params.oa}
            onOpenAccessChange={(value) => applyWith({ oa: value || undefined })}
            personal={personal}
            canReset={canReset}
            onReset={onReset}
            resultCount={resultCount}
            onShowResults={showResults}
          />
        )}
      </section>
    );
  }

  const submitYears = (event: FormEvent, close: () => void) => {
    event.preventDefault();
    if (applyYears()) close();
  };

  return (
    <section className="search-filters" aria-label={t("common.filters")}>
      <div className="chip-row search-filters-row">
        <Popover
          open={yearOpen}
          onOpenChange={setYearOpen}
          labelledBy={`${id}-year-title`}
          initialFocusRef={yearFocusRef}
          className="search-year-popover"
          testId="search-year-popover"
          trigger={(props) => (
            <MenuChip {...props} active={!!yearsText}>
              {yearsText ? t("search.yearChipValue", { value: yearsText }) : t("search.yearChip")}
            </MenuChip>
          )}
        >
          {(close) => (
            <>
              <p id={`${id}-year-title`} className="popover-title label-caps">
                {t("search.yearRange")}
              </p>
              {YEAR_PRESETS.map((option) => {
                const current = option === preset;
                return (
                  <button
                    key={option}
                    ref={current ? presetRef : undefined}
                    type="button"
                    className={`popover-option${current ? " popover-option--active" : ""}`}
                    aria-pressed={current}
                    onClick={() => {
                      if (option === "custom") {
                        fromRef.current?.focus();
                        return;
                      }
                      applyPreset(option);
                      close();
                    }}
                  >
                    {yearPresetLabel(option, t)}
                  </button>
                );
              })}
              <form
                className="popover-section search-years"
                onSubmit={(event) => submitYears(event, close)}
                noValidate
              >
                <YearFields id={`${id}-popover`} drafts={drafts} fromRef={fromRef} />
                <div className="popover-footer">
                  <button
                    type="button"
                    className="btn-quiet"
                    onClick={() => {
                      drafts.set({});
                      onChange({ year_from: undefined, year_to: undefined });
                      close();
                    }}
                  >
                    {t("search.clearYears")}
                  </button>
                  <button type="submit" className="btn btn-primary btn--sm">
                    {t("search.applyYears")}
                  </button>
                </div>
              </form>
            </>
          )}
        </Popover>

        {openAccessChip}
        {personalChips}
        <span className="chip-row-spacer" aria-hidden="true" />

        <Popover
          haspopup="listbox"
          align="end"
          testId="search-sort-popover"
          trigger={(props) => (
            <MenuChip
              {...props}
              prefix={t("search.sortChip")}
              active={appliedSort !== DEFAULT_SEARCH_SORT}
              aria-describedby={sortHint ? hintId : undefined}
            >
              {sortLabels[sort]}
            </MenuChip>
          )}
        >
          {(close) => (
            <PopoverListbox
              label={t("common.sortBy")}
              options={sortOptions}
              value={sort}
              onSelect={(value) => {
                close();
                if (value !== appliedSort) applyWith({ sort: value });
              }}
            />
          )}
        </Popover>

        {canReset && (
          <button type="button" className="btn-quiet" aria-label={t("common.resetFilters")} onClick={onReset}>
            {t("search.reset")}
          </button>
        )}
      </div>
      {hint}
    </section>
  );
});

export default SearchFilters;
