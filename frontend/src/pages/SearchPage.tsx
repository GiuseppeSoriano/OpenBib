import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useNavigationType, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api, { library, papers } from "@/lib/api";
import { apiErrorCode } from "@/lib/apiError";
import { useAuth } from "@/contexts/AuthContext";
import { useScrollRestore } from "@/hooks/useScrollRestore";
import type { PaperMemberships, PaperMetadata, SearchResultItem } from "@/types";
import { Search, SearchX, X } from "lucide-react";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import QueryError from "@/components/ui/QueryError";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import { providerLabel } from "@/components/paper/versionLabel";
import SearchResultCard from "@/components/search/SearchResultCard";
import VersionPicker from "@/components/search/VersionPicker";
import SearchFilters, { type SearchFiltersHandle } from "@/components/search/SearchFilters";
import { yearRangeText } from "@/components/search/yearRange";
import { useShellChrome } from "@/components/shell/ShellContext";
import { shortcutLabel } from "@/components/shell/shortcuts";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { COMPACT_QUERY } from "@/lib/breakpoints";
import SearchStatus, { type SearchStatusKind } from "@/components/search/SearchStatus";
import {
  retryHelps,
  retryWaitUntil,
  searchErrorText,
  useSecondsUntil,
} from "@/components/search/searchRetry";
import PossibleVersionNote from "@/components/search/PossibleVersionNote";
import { itemGroupKey, mergeSearchPages, nextSearchPage, resultElementId } from "@/lib/search-pages";
import {
  activeFilterCount,
  parseSearchParams,
  SEARCH_QUERY_MAX,
  serializeSearchParams,
  toApiParams,
  type SearchPageParam,
  type SearchParamsState,
} from "@/lib/searchParams";
import { clearLastSearch, getLastSearch, setLastSearch } from "@/lib/lastSearch";
import "./SearchPage.css";

/** The provider that answers searches when a response does not name one. */
const DEFAULT_SOURCE = "semantic_scholar";
const HIGHLIGHT_MS = 2000;

function getSelectedPaper(
  item: SearchResultItem,
  selectedVersions: Record<string, string>,
): PaperMetadata {
  if (item.kind === "paper") return item.paper;
  const selectedKey =
    selectedVersions[item.paper_group_key] ?? item.selected_version.canonical_key;
  return (
    item.versions.find((paper) => paper.canonical_key === selectedKey) ?? item.selected_version
  );
}

export default function SearchPage() {
  const { t } = useTranslation();
  const { user, isLoading: authLoading } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const filtersRef = useRef<SearchFiltersHandle>(null);
  const compact = useMediaQuery(COMPACT_QUERY);
  // The page's own header and field lead: no breadcrumb bar, no phone app bar.
  useShellChrome({ topBar: false, mobileTopBar: false });

  // The URL is the source of truth. Keyed by the normalized search so
  // equivalent URLs share one query and cache entry.
  const serialized = serializeSearchParams(parseSearchParams(searchParams)).toString();
  const state = useMemo(() => parseSearchParams(new URLSearchParams(serialized)), [serialized]);

  // Typing stays local until submitted; the box follows the URL when it
  // changes (back/forward, a restored search).
  const [query, setQuery] = useState(state.q);
  const [syncedQ, setSyncedQ] = useState(state.q);
  if (state.q !== syncedQ) {
    setSyncedQ(state.q);
    setQuery(state.q);
  }

  const [unsavedOnly, setUnsavedOnly] = useState(false);
  const [hideDismissed, setHideDismissed] = useState(true);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  // A fresh object per Show, so showing the same card again restarts the timer.
  const [highlight, setHighlight] = useState<{ key: string } | null>(null);

  // Remember the search on screen. A bare /search reached by a link (the
  // Search tab) reopens the last one, replacing the bare entry; one reached
  // with Back stays blank, as history says. Once per location, so the
  // StrictMode double effect navigates once.
  const handledLocation = useRef<string | null>(null);
  useEffect(() => {
    if (handledLocation.current === location.key) return;
    handledLocation.current = location.key;
    if (state.q) {
      setLastSearch(serialized);
      return;
    }
    if (serialized) return;
    const last = navigationType === "POP" ? null : getLastSearch();
    if (last) navigate({ search: `?${last}` }, { replace: true });
    else clearLastSearch();
  }, [location.key, navigationType, navigate, serialized, state.q]);

  const searchQuery = useInfiniteQuery({
    queryKey: ["search", serialized],
    initialPageParam: { page: 1 } as SearchPageParam,
    queryFn: ({ pageParam, signal }) => papers.search(toApiParams(state, pageParam), { signal }),
    getNextPageParam: (last) => nextSearchPage(state, last),
    enabled: !!state.q && !authLoading,
    retry: false,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const pages = searchQuery.data?.pages;
  const items = useMemo(() => (pages ? mergeSearchPages(pages) : undefined), [pages]);
  // A Retry-After holds back every retry, searching again included.
  const retryAt = searchQuery.isError
    ? retryWaitUntil(searchQuery.error, searchQuery.errorUpdatedAt)
    : null;

  // A new search starts from each group's default version.
  useEffect(() => { setSelectedVersions({}); }, [serialized]);

  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  // A new search (or arriving from a scrolled page) starts at the top, with the
  // status line clear of the sticky field. Before the restore below, so Back
  // still returns to the position recorded for a search.
  useLayoutEffect(() => {
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }, [serialized]);

  useScrollRestore(`search?${serialized}`, !!items);

  // The sticky field (on phones with its chip row) covers the top of the
  // viewport: the root's scroll padding clears its measured height at any
  // text size, so focus and scrolled-to targets land below it.
  const topRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const top = topRef.current;
    const bar = barRef.current;
    if (!top || !bar) return;
    const root = document.documentElement;
    const height = (el: HTMLElement) => `${Math.ceil(el.getBoundingClientRect().height)}px`;
    const update = () => {
      root.style.setProperty("--search-top-height", height(top));
      root.style.setProperty("--search-bar-height", height(bar));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(top, { box: "border-box" });
    observer.observe(bar, { box: "border-box" });
    return () => {
      observer.disconnect();
      root.style.removeProperty("--search-top-height");
      root.style.removeProperty("--search-bar-height");
    };
  }, []);

  // User-scoped overlays: never fired anonymously (no 401 noise).
  const { data: memberships } = useQuery({
    queryKey: ["paper-memberships"],
    queryFn: async () => {
      const { data } = await api.get<PaperMemberships>("/collections/paper-memberships");
      return data;
    },
    enabled: !!items && !!user,
    staleTime: 30_000,
  });

  const { data: dismissedKeys } = useQuery({
    queryKey: ["dismissed-papers"],
    queryFn: async () => {
      const { data } = await api.get<string[]>("/papers/dismissed");
      return data;
    },
    enabled: !!items && !!user,
    staleTime: 30_000,
  });

  const { data: libraryKeys } = useQuery({
    queryKey: ["library-keys"],
    queryFn: () => library.listKeys(),
    enabled: !!items && !!user,
    staleTime: 30_000,
  });

  const dismissedSet = new Set(dismissedKeys ?? []);
  const librarySet = new Set(libraryKeys ?? []);
  const membershipsMap = memberships ?? {};

  const filteredItems = items?.filter((item) => {
    const selectedPaper = getSelectedPaper(item, selectedVersions);
    if (hideDismissed && dismissedSet.has(selectedPaper.canonical_key)) return false;
    if (unsavedOnly && membershipsMap[selectedPaper.canonical_key]?.length) return false;
    return true;
  });
  const shownKeys = new Set((filteredItems ?? []).map(itemGroupKey));

  /** Applies a search: one history entry, and none when nothing changed. */
  const commit = (next: SearchParamsState) => {
    const nextSearch = serializeSearchParams(next).toString();
    if (nextSearch === serialized) {
      // Searching again after a failure retries it, once any wait is over.
      const waiting = retryAt !== null && Date.now() < retryAt;
      if (searchQuery.isError && !searchQuery.isFetching && !waiting) void searchQuery.refetch();
      return;
    }
    // Without words nothing runs: store the filters without a history entry.
    setSearchParams(new URLSearchParams(nextSearch), { replace: !next.q });
  };

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    // Years typed but not applied go with the search; invalid ones stop it.
    const years = filtersRef.current ? filtersRef.current.pendingYears() : {};
    if (years) commit({ ...state, ...years, q });
  };

  // A filter change also submits words typed but not yet searched.
  const changeFilters = (patch: Partial<SearchParamsState>) =>
    commit({ ...state, q: query.trim() || state.q, ...patch });
  const personalActive = !!user && (unsavedOnly || !hideDismissed);
  const resetFilters = () => {
    setUnsavedOnly(false);
    setHideDismissed(true);
    commit({ q: query.trim() || state.q, sort: state.sort });
  };

  const clearQuery = () => {
    setQuery("");
    inputRef.current?.focus();
  };

  const showRelated = useCallback((key: string) => setHighlight({ key }), []);

  const { error, isError, isFetching, isFetchNextPageError, hasNextPage, isFetchingNextPage } =
    searchQuery;
  const lastPage = pages && pages.length > 0 ? pages[pages.length - 1] : undefined;
  const provider = providerLabel(lastPage?.source ?? DEFAULT_SOURCE);
  const totalEstimate = lastPage?.total_estimate ?? pages?.[0]?.total_estimate ?? null;
  const windowCapped = !!pages?.some((page) => page.window_capped);
  const pageError = isError && !!items;
  const pageWait = useSecondsUntil(pageError ? retryAt : null);

  let statusKind: SearchStatusKind = "idle";
  if (items) statusKind = items.length > 0 ? "results" : "empty";
  else if (isError) statusKind = "error";
  else if (state.q) statusKind = "loading";

  // A failed next page keeps the loaded results; an expired cursor restarts.
  const retryPage = () =>
    void (isFetchNextPageError && apiErrorCode(error) !== "invalid_cursor"
      ? searchQuery.fetchNextPage()
      : searchQuery.refetch());

  // The phone sheet's "Show N results": the provider's estimate, once known.
  const resultCount =
    statusKind === "results" || statusKind === "empty" ? (totalEstimate ?? filteredItems?.length ?? 0) : null;

  // The status line names the filters in force: "2019–2023 · most cited first".
  const filterSummary = [
    yearRangeText(state, t),
    state.oa ? t("search.statusOpenAccess") : null,
    user && unsavedOnly ? t("search.statusUnsaved") : null,
    user && !hideDismissed ? t("search.statusDismissedShown") : null,
    state.sort === "date" ? t("search.statusSortDate") : null,
    state.sort === "citations" ? t("search.statusSortCitations") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="search-page">
      <header className="search-header">
        <h1 ref={headingRef} tabIndex={-1}>
          {t("search.title")}
        </h1>
      </header>

      {/* Phones: the field and the chip row stay at the top together. */}
      <div ref={topRef} className="search-top">
        <form ref={barRef} onSubmit={handleSearch} className="search-bar" role="search">
          <div className="search-field">
            <label htmlFor={inputId} className="sr-only">
              {t("search.queryLabel")}
            </label>
            <Search size={18} className="search-icon" aria-hidden="true" />
            <input
              id={inputId}
              ref={inputRef}
              className="search-input"
              type="text"
              enterKeyHint="search"
              aria-keyshortcuts="/"
              maxLength={SEARCH_QUERY_MAX}
              placeholder={t("search.placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus={!state.q}
            />
            <span className="search-kbd" aria-hidden="true">
              <kbd>/</kbd>
              <kbd>{shortcutLabel()}</kbd>
            </span>
            {query && (
              <button
                type="button"
                className="btn-ghost search-clear"
                aria-label={t("search.clear")}
                onClick={clearQuery}
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
          <button type="submit" className="btn btn-primary search-submit">
            {t("search.submit")}
          </button>
        </form>

        <SearchFilters
          ref={filtersRef}
          params={state}
          onChange={changeFilters}
          onReset={resetFilters}
          personal={
            user
              ? {
                  unsavedOnly,
                  hideDismissed,
                  onUnsavedOnlyChange: setUnsavedOnly,
                  onHideDismissedChange: setHideDismissed,
                }
              : null
          }
          personalActive={personalActive}
          resultCount={resultCount}
        />
      </div>

      <SearchStatus
        kind={statusKind}
        provider={provider}
        shown={filteredItems?.length ?? 0}
        total={totalEstimate}
        windowCapped={windowCapped}
        filters={filterSummary || null}
        error={statusKind === "error" ? error : undefined}
        retryAt={retryAt}
        retrying={isFetching}
        onRetry={retryHelps(error) ? () => void searchQuery.refetch() : undefined}
      />

      {statusKind === "loading" && <SkeletonCard count={4} />}

      {filteredItems && filteredItems.length > 0 && (
        <section className="search-results" aria-labelledby={`${inputId}-results`}>
          <h2 id={`${inputId}-results`} className="sr-only">
            {t("search.resultsHeading")}
          </h2>
          <ol className="list-rows list-rows--ruled search-list">
            {filteredItems.map((item) => {
              const groupKey = itemGroupKey(item);
              const selected = getSelectedPaper(item, selectedVersions);
              const related = (item.possible_versions ?? []).filter(
                (version) => version.paper_group_key !== groupKey,
              );
              const highlighted = highlight?.key === groupKey;
              return (
                <li
                  key={groupKey}
                  id={resultElementId(groupKey)}
                  tabIndex={-1}
                  className={`list-row search-result${highlighted ? " search-result--highlight" : ""}`}
                >
                  <SearchResultCard
                    paper={selected}
                    compact={compact}
                    providerSources={
                      item.kind === "paper_group"
                        ? (item.provider_sources ?? selected.provider_sources ?? [])
                        : (selected.provider_sources ?? [])
                    }
                    savedInCollections={membershipsMap[selected.canonical_key] ?? []}
                    isDismissed={dismissedSet.has(selected.canonical_key)}
                    inLibrary={librarySet.has(selected.paper_group_key)}
                    onOpenDetails={setDetailsKey}
                    note={
                      related.length > 0 ? (
                        <PossibleVersionNote
                          versions={related}
                          isShown={(key) => shownKeys.has(key)}
                          onShow={showRelated}
                        />
                      ) : undefined
                    }
                  >
                    {item.kind === "paper_group" && (
                      <VersionPicker
                        versions={item.versions}
                        selectedKey={selected.canonical_key}
                        onSelect={(version) =>
                          setSelectedVersions((current) => ({
                            ...current,
                            [item.paper_group_key]: version.canonical_key,
                          }))
                        }
                      />
                    )}
                  </SearchResultCard>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {filteredItems && filteredItems.length === 0 && (
        <EmptyState
          icon={SearchX}
          title={t("search.emptyTitle")}
          description={t("search.emptyDescription")}
          action={
            activeFilterCount(state) > 0 || personalActive ? (
              <button type="button" className="btn btn-secondary" onClick={resetFilters}>
                {t("common.resetFilters")}
              </button>
            ) : undefined
          }
        />
      )}

      {pageError && (
        <QueryError
          message={searchErrorText(error, t, retryAt !== null)}
          busy={isFetching || pageWait > 0}
          onRetry={retryPage}
        />
      )}

      {hasNextPage && !pageError && (
        <div className="load-more">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={isFetching}
            onClick={() => void searchQuery.fetchNextPage()}
          >
            {t(isFetchingNextPage ? "common.loading" : "common.showMore")}
          </button>
        </div>
      )}

      <PaperDetailsPanel
        paperKey={detailsKey}
        onClose={() => setDetailsKey(null)}
        fallbackFocus={() => headingRef.current}
      />
    </div>
  );
}
