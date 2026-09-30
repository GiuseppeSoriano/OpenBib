import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal } from "lucide-react";
import { COMPACT_QUERY } from "@/lib/breakpoints";
import {
  activeFilterCount,
  DEFAULT_SEARCH_SORT,
  maxSearchYear,
  MIN_SEARCH_YEAR,
  parseYear,
  SEARCH_SORTS,
  type SearchParamsState,
} from "@/lib/searchParams";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { SearchSort } from "@/types";
import "./SearchFilters.css";

const SORT_LABELS: Record<SearchSort, string> = {
  relevance: "search.sortRelevance",
  date: "search.sortNewest",
  citations: "search.sortMostCited",
};

type FilterPatch = Partial<Omit<SearchParamsState, "q">>;
type YearPatch = Pick<SearchParamsState, "year_from" | "year_to">;

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
}

/** Idle time before a sort change applies, so arrowing through a closed select runs one search. */
const SORT_DELAY_MS = 400;

const yearText = (year: number | undefined) => (year === undefined ? "" : String(year));

/**
 * Year range, open access and sort for Search. The applied values live in
 * the URL (see lib/searchParams): the toggle applies at once, the sort once
 * the choice settles, the years with Apply (or Enter) or with the next
 * search. On compact screens the controls fold behind a Filters toggle.
 */
const SearchFilters = forwardRef<SearchFiltersHandle, Props>(function SearchFilters(
  { params, onChange, onReset },
  ref,
) {
  const { t } = useTranslation();
  const id = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const [open, setOpen] = useState(false);
  const activeCount = activeFilterCount(params);

  // Typed years stay local until applied (Apply, or any other search or
  // filter change); follow the URL when it changes (back/forward, reset)
  // without clobbering unapplied input otherwise.
  const applied = `${yearText(params.year_from)}-${yearText(params.year_to)}`;
  const [syncedYears, setSyncedYears] = useState(applied);
  const [fromDraft, setFromDraft] = useState(yearText(params.year_from));
  const [toDraft, setToDraft] = useState(yearText(params.year_to));
  const [yearError, setYearError] = useState<string | null>(null);
  if (applied !== syncedYears) {
    setSyncedYears(applied);
    setFromDraft(yearText(params.year_from));
    setToDraft(yearText(params.year_to));
    setYearError(null);
  }

  /** The typed years, validated; null (with the error shown) when invalid. */
  const readYears = (): YearPatch | null => {
    const from = fromDraft.trim() ? parseYear(fromDraft) : undefined;
    const to = toDraft.trim() ? parseYear(toDraft) : undefined;
    let error: string | null = null;
    if ((fromDraft.trim() && from === undefined) || (toDraft.trim() && to === undefined)) {
      error = t("search.yearInvalid", { min: MIN_SEARCH_YEAR, max: maxSearchYear() });
    } else if (from !== undefined && to !== undefined && from > to) {
      error = t("errors.invalid_year_range");
    }
    setYearError(error);
    if (!error) return { year_from: from, year_to: to };
    setOpen(true);
    return null;
  };

  /** Typed years that differ from the applied ones; {} when there are none. */
  const pendingYears = (): YearPatch | null => {
    if (`${fromDraft.trim()}-${toDraft.trim()}` !== applied) return readYears();
    setYearError(null);
    return {};
  };
  useImperativeHandle(ref, () => ({ pendingYears }));

  const applyYears = (event: FormEvent) => {
    event.preventDefault();
    const years = readYears();
    if (years) onChange(years);
  };

  /** A toggle or sort change also applies valid typed years. */
  const applyWith = (patch: FilterPatch) => onChange({ ...pendingYears(), ...patch });

  // A sort change waits for the choice to settle (arrow keys on a closed
  // select fire one change per option), or applies when focus leaves.
  const [pendingSort, setPendingSort] = useState<SearchSort | null>(null);
  const sortTimer = useRef<number | undefined>(undefined);
  const sort = pendingSort ?? params.sort ?? DEFAULT_SEARCH_SORT;
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

  const panelId = `${id}-panel`;
  const errorId = `${id}-year-error`;
  const hintId = `${id}-sort-hint`;
  const sortHint = sort !== DEFAULT_SEARCH_SORT;

  return (
    <section className="search-filters" aria-label={t("common.filters")}>
      {compact && (
        <button
          type="button"
          className="btn btn-secondary search-filters-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          {t("common.filters")}
          {activeCount > 0 && <span className="badge">{activeCount}</span>}
        </button>
      )}

      <div id={panelId} className="search-filters-panel" hidden={compact && !open}>
        <form className="search-filters-years" onSubmit={applyYears} noValidate>
          <fieldset>
            <legend>{t("search.yearRange")}</legend>
            <div className="search-filters-year-row">
              <div className="search-filters-field search-filters-year">
                <label htmlFor={`${id}-from`}>{t("search.yearFrom")}</label>
                <input
                  id={`${id}-from`}
                  type="number"
                  inputMode="numeric"
                  className="input"
                  min={MIN_SEARCH_YEAR}
                  max={maxSearchYear()}
                  value={fromDraft}
                  aria-invalid={yearError ? true : undefined}
                  aria-describedby={yearError ? errorId : undefined}
                  onChange={(event) => setFromDraft(event.target.value)}
                />
              </div>
              <div className="search-filters-field search-filters-year">
                <label htmlFor={`${id}-to`}>{t("search.yearTo")}</label>
                <input
                  id={`${id}-to`}
                  type="number"
                  inputMode="numeric"
                  className="input"
                  min={MIN_SEARCH_YEAR}
                  max={maxSearchYear()}
                  value={toDraft}
                  aria-invalid={yearError ? true : undefined}
                  aria-describedby={yearError ? errorId : undefined}
                  onChange={(event) => setToDraft(event.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-secondary search-filters-apply">
                {t("search.applyYears")}
              </button>
            </div>
          </fieldset>
          {yearError && (
            <p id={errorId} className="search-filters-error" role="alert">
              {yearError}
            </p>
          )}
        </form>

        <button
          type="button"
          className={`pill search-filters-oa ${params.oa ? "active" : ""}`}
          aria-pressed={!!params.oa}
          onClick={() => applyWith({ oa: !params.oa || undefined })}
        >
          {t("search.openAccessOnly")}
        </button>

        <div className="search-filters-field search-filters-sort">
          <label htmlFor={`${id}-sort`}>{t("common.sortBy")}</label>
          <select
            id={`${id}-sort`}
            className="input"
            value={sort}
            aria-describedby={sortHint ? hintId : undefined}
            onChange={(event) => changeSort(event.target.value as SearchSort)}
            onBlur={applySort}
          >
            {SEARCH_SORTS.map((option) => (
              <option key={option} value={option}>
                {t(SORT_LABELS[option])}
              </option>
            ))}
          </select>
        </div>

        {sortHint && (
          <p id={hintId} className="search-filters-hint">
            {t("search.sortAllWordsHint")}
          </p>
        )}
      </div>

      {activeCount > 0 && (
        <div className="search-filters-active">
          <span>{t("common.filtersActive", { count: activeCount })}</span>
          <button type="button" className="btn-ghost search-filters-reset" onClick={onReset}>
            {t("common.resetFilters")}
          </button>
        </div>
      )}
    </section>
  );
});

export default SearchFilters;
