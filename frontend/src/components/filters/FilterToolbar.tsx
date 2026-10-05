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
import { useTranslation } from "react-i18next";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { COMPACT_QUERY } from "@/lib/breakpoints";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import Popover, { PopoverListbox, type ListboxOption } from "@/components/ui/Popover";
import { MenuChip } from "@/components/ui/Chip";
import "./FilterToolbar.css";

const SEARCH_DEBOUNCE_MS = 300;

interface FilterToolbarProps {
  /** Accessible name and placeholder of the text filter. */
  searchLabel: string;
  searchPlaceholder: string;
  /** The committed text (from the URL); the field types ahead of it. */
  query: string;
  maxLength: number;
  /** Debounced while typing; the caller replaces the history entry. */
  onQueryChange: (query: string) => void;
  /** Active filters (the sort order is not one). */
  activeCount: number;
  onReset: () => void;
  /** Filter chips, before the spacer. */
  filters?: ReactNode;
  /** The sort chip, at the end of the row. */
  sort: ReactNode;
}

/**
 * The text filter, filter chips and sort of a list (the Library, a
 * collection). Each filter is a chip that opens a listbox popover; on
 * compact screens the chips fold behind a Filters toggle. The class names
 * keep the Library's, where the toolbar started.
 */
export default function FilterToolbar({
  searchLabel,
  searchPlaceholder,
  query,
  maxLength,
  onQueryChange,
  activeCount,
  onReset,
  filters,
  sort,
}: FilterToolbarProps) {
  const { t } = useTranslation();
  const id = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // The search box types ahead of the URL; follow URL changes made elsewhere
  // (reset, back/forward) without clobbering what is being typed.
  const [draft, setDraft] = useState(query);
  const [syncedQ, setSyncedQ] = useState(query);
  if (query !== syncedQ) {
    setSyncedQ(query);
    if (query !== draft.trim()) setDraft(query);
  }

  useEffect(() => {
    if (draft.trim() === query) return;
    const timer = window.setTimeout(() => onQueryChange(draft), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, query, onQueryChange]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() !== query) onQueryChange(draft);
  };

  const clearSearch = () => {
    setDraft("");
    if (query) onQueryChange("");
    inputRef.current?.focus();
  };

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
            {searchLabel}
          </label>
          <Search size={16} className="library-filters-search-icon" aria-hidden="true" />
          <input
            id={`${id}-q`}
            ref={inputRef}
            type="search"
            className="input"
            value={draft}
            maxLength={maxLength}
            placeholder={searchPlaceholder}
            onChange={(event) => setDraft(event.target.value)}
          />
          {draft && (
            <button
              type="button"
              className="btn-ghost library-filters-clear"
              aria-label={t("search.clear")}
              onClick={clearSearch}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
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
        {filters}
        <span className="chip-row-spacer" aria-hidden="true" />
        {sort}
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
export function FilterMenu({
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
        // Search's sort chip prefix ("Sort"), so every sort chip reads alike. The
        // trailing space keeps the prefix and value apart in the accessible name.
        <MenuChip {...props} active={active} prefix={sort ? `${t("search.sortChip")} ` : undefined}>
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
