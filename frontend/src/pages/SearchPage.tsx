import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useNavigationType, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api, { library, papers } from "@/lib/api";
import { apiErrorCode } from "@/lib/apiError";
import { useAuth } from "@/contexts/AuthContext";
import { useScrollRestore } from "@/hooks/useScrollRestore";
import type { PaperMemberships, PaperMetadata, SearchResultItem } from "@/types";
import { EyeOff, FolderCheck, Search, SearchX, X } from "lucide-react";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import QueryError from "@/components/ui/QueryError";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import { providerLabel } from "@/components/paper/versionLabel";
import SearchResultCard from "@/components/search/SearchResultCard";
import VersionPicker from "@/components/search/VersionPicker";
import SearchFilters, { type SearchFiltersHandle } from "@/components/search/SearchFilters";
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

  useScrollRestore(`search?${serialized}`, !!items);

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
  const resetFilters = () => commit({ q: query.trim() || state.q, sort: state.sort });

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

  return (
    <div className="search-page">
      <header className="search-header">
        <h1 ref={headingRef} tabIndex={-1}>
          {t("search.title")}
        </h1>
      </header>

      <form onSubmit={handleSearch} className="search-bar" role="search">
        <div className="search-input-wrap">
          <label htmlFor={inputId} className="sr-only">
            {t("search.queryLabel")}
          </label>
          <Search size={17} className="search-icon" aria-hidden="true" />
          <input
            id={inputId}
            ref={inputRef}
            className="input search-input"
            type="text"
            maxLength={SEARCH_QUERY_MAX}
            placeholder={t("search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus={!state.q}
          />
          {query && (
            <button
              type="button"
              className="btn-ghost search-clear"
              aria-label={t("search.clear")}
              onClick={clearQuery}
            >
              <X size={15} aria-hidden="true" />
            </button>
          )}
        </div>
        <button type="submit" className="btn btn-primary">
          {t("search.submit")}
        </button>
      </form>

      <SearchFilters ref={filtersRef} params={state} onChange={changeFilters} onReset={resetFilters} />

      <SearchStatus
        kind={statusKind}
        provider={provider}
        shown={filteredItems?.length ?? 0}
        total={totalEstimate}
        windowCapped={windowCapped}
        error={statusKind === "error" ? error : undefined}
        retryAt={retryAt}
        retrying={isFetching}
        onRetry={retryHelps(error) ? () => void searchQuery.refetch() : undefined}
      />

      {statusKind === "loading" && <SkeletonCard count={4} />}

      {filteredItems && (
        <section className="search-results" aria-labelledby={`${inputId}-results`}>
          <h2 id={`${inputId}-results`} className="sr-only">
            {t("search.resultsHeading")}
          </h2>
          {user && (
            <div className="search-pills">
              <button
                type="button"
                className={`pill ${unsavedOnly ? "active" : ""}`}
                aria-pressed={unsavedOnly}
                onClick={() => setUnsavedOnly((v) => !v)}
              >
                <FolderCheck size={13} aria-hidden="true" />
                {t("search.unsavedOnly")}
              </button>
              <button
                type="button"
                className={`pill ${hideDismissed ? "active" : ""}`}
                aria-pressed={hideDismissed}
                onClick={() => setHideDismissed((v) => !v)}
              >
                <EyeOff size={13} aria-hidden="true" />
                {t("search.hideDismissed")}
              </button>
            </div>
          )}

          <div className="search-list">
            {filteredItems.map((item) => {
              const groupKey = itemGroupKey(item);
              const selected = getSelectedPaper(item, selectedVersions);
              const related = (item.possible_versions ?? []).filter(
                (version) => version.paper_group_key !== groupKey,
              );
              const highlighted = highlight?.key === groupKey;
              return (
                <div
                  key={groupKey}
                  id={resultElementId(groupKey)}
                  tabIndex={-1}
                  className={`search-result${highlighted ? " search-result--highlight" : ""}`}
                >
                  <SearchResultCard
                    paper={selected}
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
                </div>
              );
            })}
          </div>
        </section>
      )}

      {filteredItems && filteredItems.length === 0 && (
        <EmptyState
          icon={SearchX}
          title={t("search.emptyTitle")}
          description={t("search.emptyDescription")}
          action={
            activeFilterCount(state) > 0 ? (
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
