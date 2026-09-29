import { useEffect, useId, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Search, SlidersHorizontal } from "lucide-react";
import api, { library } from "@/lib/api";
import { COMPACT_QUERY } from "@/lib/breakpoints";
import {
  activeFilterCount,
  DEFAULT_LIBRARY_SORT,
  LIBRARY_QUERY_MAX,
  LIBRARY_SORTS,
  type LibraryFilterParams,
} from "@/lib/libraryParams";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { READING_STATES, type Collection, type LibrarySort, type ReadingState } from "@/types";
import "./LibraryFilters.css";

const SEARCH_DEBOUNCE_MS = 300;

const SORT_LABELS: Record<LibrarySort, string> = {
  added: "library.sortAdded",
  title: "library.sortTitle",
  year: "library.sortYear",
  citations: "library.sortCitations",
};

interface Props {
  params: LibraryFilterParams;
  /** `replace` is set for typed searches so each keystroke is not a history entry. */
  onChange: (next: LibraryFilterParams, options?: { replace?: boolean }) => void;
  onReset: () => void;
}

/**
 * Search, filters and sort for the Library list. The values live in the URL
 * (see lib/libraryParams); on compact screens everything but the search box
 * folds behind a Filters toggle.
 */
export default function LibraryFilters({ params, onChange, onReset }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const [open, setOpen] = useState(false);
  const activeCount = activeFilterCount(params);

  const { data: facets } = useQuery({
    queryKey: ["library-entries", "facets"],
    queryFn: () => library.getFacets(),
  });
  const { data: collections } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => (await api.get<Collection[]>("/collections")).data,
  });

  // The search box types ahead of the URL; follow URL changes made elsewhere
  // (reset, back/forward) without clobbering what is being typed.
  const committedQ = params.q ?? "";
  const [draft, setDraft] = useState(committedQ);
  const [syncedQ, setSyncedQ] = useState(committedQ);
  if (committedQ !== syncedQ) {
    setSyncedQ(committedQ);
    if (committedQ !== draft.trim()) setDraft(committedQ);
  }

  useEffect(() => {
    if (draft.trim() === committedQ) return;
    const timer = window.setTimeout(
      () => onChange({ ...params, q: draft }, { replace: true }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [draft, committedQ, params, onChange]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() !== committedQ) onChange({ ...params, q: draft }, { replace: true });
  };

  const setFilter = (patch: LibraryFilterParams) => onChange({ ...params, ...patch });

  const stateOptions: ReadingState[] = facets
    ? READING_STATES.filter(
        (state) => state === params.state || facets.states.some((f) => f.state === state),
      )
    : READING_STATES;
  const stateCount = (state: ReadingState) => facets?.states.find((f) => f.state === state)?.count;
  const tagOptions = facets?.tags ?? [];
  const selectedTagMissing = !!params.tag && !tagOptions.some((f) => f.tag === params.tag);
  const collectionOptions = collections ?? [];
  const selectedCollectionMissing =
    !!params.collection_id && !collectionOptions.some((c) => c.id === params.collection_id);

  const withCount = (label: string, count: number | undefined) =>
    count === undefined ? label : t("library.optionCount", { label, count });

  const panelId = `${id}-panel`;

  return (
    <section className="library-filters" aria-label={t("common.filters")}>
      <div className="library-filters-bar">
        <form role="search" className="library-filters-search" onSubmit={submitSearch}>
          <label htmlFor={`${id}-q`} className="sr-only">
            {t("library.searchLabel")}
          </label>
          <Search size={15} className="library-filters-search-icon" aria-hidden="true" />
          <input
            id={`${id}-q`}
            type="search"
            className="input"
            value={draft}
            maxLength={LIBRARY_QUERY_MAX}
            placeholder={t("library.searchPlaceholder")}
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
        {compact && (
          <button
            type="button"
            className="btn btn-secondary library-filters-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            {t("common.filters")}
            {activeCount > 0 && <span className="badge">{activeCount}</span>}
          </button>
        )}
      </div>

      <div id={panelId} className="library-filters-panel" hidden={compact && !open}>
        {stateOptions.length > 0 && (
          <div className="library-filters-field">
            <label htmlFor={`${id}-state`}>{t("library.filterState")}</label>
            <select
              id={`${id}-state`}
              className="input"
              value={params.state ?? ""}
              onChange={(event) =>
                setFilter({ state: (event.target.value || undefined) as ReadingState | undefined })
              }
            >
              <option value="">{t("library.anyState")}</option>
              {stateOptions.map((state) => (
                <option key={state} value={state}>
                  {withCount(t(`paper.states.${state}`), stateCount(state))}
                </option>
              ))}
            </select>
          </div>
        )}

        {(tagOptions.length > 0 || params.tag) && (
          <div className="library-filters-field">
            <label htmlFor={`${id}-tag`}>{t("library.filterTag")}</label>
            <select
              id={`${id}-tag`}
              className="input"
              value={params.tag ?? ""}
              onChange={(event) => setFilter({ tag: event.target.value || undefined })}
            >
              <option value="">{t("library.anyTag")}</option>
              {selectedTagMissing && <option value={params.tag}>{params.tag}</option>}
              {tagOptions.map((facet) => (
                <option key={facet.tag} value={facet.tag}>
                  {withCount(facet.tag, facet.count)}
                </option>
              ))}
            </select>
          </div>
        )}

        {(collectionOptions.length > 0 || params.collection_id) && (
          <div className="library-filters-field">
            <label htmlFor={`${id}-collection`}>{t("library.filterCollection")}</label>
            <select
              id={`${id}-collection`}
              className="input"
              value={params.collection_id ?? ""}
              onChange={(event) => setFilter({ collection_id: event.target.value || undefined })}
            >
              <option value="">{t("library.anyCollection")}</option>
              {selectedCollectionMissing && (
                <option value={params.collection_id}>{t("library.otherCollection")}</option>
              )}
              {collectionOptions.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="library-filters-field">
          <label htmlFor={`${id}-sort`}>{t("common.sortBy")}</label>
          <select
            id={`${id}-sort`}
            className="input"
            value={params.sort ?? DEFAULT_LIBRARY_SORT}
            onChange={(event) => setFilter({ sort: event.target.value as LibrarySort })}
          >
            {LIBRARY_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {t(SORT_LABELS[sort])}
              </option>
            ))}
          </select>
        </div>
      </div>

      {activeCount > 0 && (
        <div className="library-filters-active">
          <span>{t("common.filtersActive", { count: activeCount })}</span>
          <button type="button" className="btn-ghost library-filters-reset" onClick={onReset}>
            {t("common.resetFilters")}
          </button>
        </div>
      )}
    </section>
  );
}
