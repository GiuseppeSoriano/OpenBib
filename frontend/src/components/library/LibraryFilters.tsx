import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
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
import Popover, { PopoverListbox, type ListboxOption } from "@/components/ui/Popover";
import { MenuChip } from "@/components/ui/Chip";
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
 * (see lib/libraryParams); each filter is a chip that opens a listbox
 * popover, and on compact screens the chips fold behind a Filters toggle.
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

  const withCount = (label: string, count: number | undefined) =>
    count === undefined ? label : t("library.optionCount", { label, count });

  const stateValues: ReadingState[] = facets
    ? READING_STATES.filter(
        (state) => state === params.state || facets.states.some((f) => f.state === state),
      )
    : READING_STATES;
  const stateCount = (state: ReadingState) => facets?.states.find((f) => f.state === state)?.count;
  const stateOptions: ListboxOption<string>[] = [
    { value: "", label: t("library.anyState") },
    ...stateValues.map((state) => ({
      value: state,
      label: withCount(t(`paper.states.${state}`), stateCount(state)),
    })),
  ];

  const tagFacets = facets?.tags ?? [];
  const selectedTagMissing = !!params.tag && !tagFacets.some((f) => f.tag === params.tag);
  const tagOptions: ListboxOption<string>[] = [
    { value: "", label: t("library.anyTag") },
    ...(selectedTagMissing && params.tag ? [{ value: params.tag, label: params.tag }] : []),
    ...tagFacets.map((facet) => ({ value: facet.tag, label: withCount(facet.tag, facet.count) })),
  ];

  const collectionList = collections ?? [];
  const selectedCollectionMissing =
    !!params.collection_id && !collectionList.some((c) => c.id === params.collection_id);
  const collectionOptions: ListboxOption<string>[] = [
    { value: "", label: t("library.anyCollection") },
    ...(selectedCollectionMissing && params.collection_id
      ? [{ value: params.collection_id, label: t("library.otherCollection") }]
      : []),
    ...collectionList.map((collection) => ({ value: collection.id, label: collection.name })),
  ];

  const sortOptions: ListboxOption<string>[] = LIBRARY_SORTS.map((sort) => ({
    value: sort,
    label: t(SORT_LABELS[sort]),
  }));
  const sort = params.sort ?? DEFAULT_LIBRARY_SORT;

  const panelId = `${id}-panel`;
  const activeSummary = activeCount > 0 && (
    <span className="library-filters-active">
      <span>{t("common.filtersActive", { count: activeCount })}</span>
      <button type="button" className="btn-quiet" onClick={onReset}>
        {t("common.resetFilters")}
      </button>
    </span>
  );

  return (
    <section className="library-filters" aria-label={t("common.filters")}>
      <div className="library-filters-bar">
        <form role="search" className="library-filters-search" onSubmit={submitSearch}>
          <label htmlFor={`${id}-q`} className="sr-only">
            {t("library.searchLabel")}
          </label>
          <Search size={16} className="library-filters-search-icon" aria-hidden="true" />
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
            className={activeCount > 0 ? "chip chip--active" : "chip"}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            {t("common.filters")}
            {activeCount > 0 && (
              <>
                <span className="chip-count" aria-hidden="true">
                  · {activeCount}
                </span>
                <span className="sr-only">{t("common.filtersActive", { count: activeCount })}</span>
              </>
            )}
          </button>
        )}
      </div>

      <div id={panelId} className="chip-row library-filters-panel" hidden={compact && !open}>
        {stateValues.length > 0 && (
          <FilterMenu
            label={t("library.filterState")}
            options={stateOptions}
            value={params.state ?? ""}
            valueLabel={params.state ? t(`paper.states.${params.state}`) : undefined}
            onSelect={(value) => setFilter({ state: (value || undefined) as ReadingState | undefined })}
          />
        )}
        {(tagFacets.length > 0 || params.tag) && (
          <FilterMenu
            label={t("library.filterTag")}
            options={tagOptions}
            value={params.tag ?? ""}
            valueLabel={params.tag}
            onSelect={(value) => setFilter({ tag: value || undefined })}
          />
        )}
        {(collectionList.length > 0 || params.collection_id) && (
          <FilterMenu
            label={t("library.filterCollection")}
            options={collectionOptions}
            value={params.collection_id ?? ""}
            valueLabel={
              params.collection_id
                ? (collectionList.find((c) => c.id === params.collection_id)?.name ??
                  t("library.otherCollection"))
                : undefined
            }
            onSelect={(value) => setFilter({ collection_id: value || undefined })}
          />
        )}
        <span className="chip-row-spacer" aria-hidden="true" />
        <FilterMenu
          label={t("common.sortBy")}
          options={sortOptions}
          value={sort}
          valueLabel={t(SORT_LABELS[sort])}
          sort={sort !== DEFAULT_LIBRARY_SORT ? "changed" : "default"}
          onSelect={(value) => setFilter({ sort: value as LibrarySort })}
        />
        {!compact && activeSummary}
      </div>
      {/* On compact screens the summary and Reset stay visible with the panel closed. */}
      {compact && activeSummary}
    </section>
  );
}

/**
 * One filter chip and its listbox popover. A filter chip names its value
 * once set ("Tag: ml"); the sort chip always shows "Sort by  <order>".
 */
function FilterMenu({
  label,
  options,
  value,
  valueLabel,
  sort,
  onSelect,
}: {
  label: string;
  options: ListboxOption<string>[];
  value: string;
  valueLabel?: string;
  /** A sort chip; "changed" when the order is not the default. */
  sort?: "default" | "changed";
  onSelect: (value: string) => void;
}) {
  const { t } = useTranslation();
  const active = sort ? sort === "changed" : !!value;
  let text = label;
  if (sort) text = valueLabel ?? label;
  else if (valueLabel) text = t("library.filterValue", { label, value: valueLabel });
  return (
    <Popover
      haspopup="listbox"
      align={sort ? "end" : "start"}
      className="library-filters-popover"
      trigger={(props) => (
        // The trailing space keeps the prefix and value apart in the accessible name.
        <MenuChip {...props} active={active} prefix={sort ? `${label} ` : undefined}>
          {text}
        </MenuChip>
      )}
    >
      {(close) => (
        <FilterListbox>
          <PopoverListbox
            label={label}
            options={options}
            value={value}
            onSelect={(next) => {
              close();
              if (next !== value) onSelect(next);
            }}
          />
        </FilterListbox>
      )}
    </Popover>
  );
}

/**
 * Long tag and collection lists scroll inside the popover: on open the
 * selected option is scrolled into view (the popover focuses it without
 * scrolling), and a typed letter jumps to the next option starting with it,
 * as the native selects did.
 */
function FilterListbox({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const selected = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (typeof selected?.scrollIntoView === "function") selected.scrollIntoView({ block: "nearest" });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLocaleLowerCase();
    if (key.length !== 1 || key === " " || event.ctrlKey || event.metaKey || event.altKey) return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const current = items.indexOf(document.activeElement as HTMLElement);
    for (let step = 1; step <= items.length; step++) {
      const item = items[(current + step) % items.length]!;
      if ((item.textContent ?? "").trim().toLocaleLowerCase().startsWith(key)) {
        event.preventDefault();
        item.focus();
        return;
      }
    }
  };

  return (
    <div ref={ref} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
