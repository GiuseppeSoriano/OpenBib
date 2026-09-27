import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AxiosError } from "axios";
import api, { library } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type {
  PaperMemberships,
  PaperMetadata,
  SearchResult,
  SearchResultItem,
} from "@/types";
import { EyeOff, FolderCheck, Search, SearchX } from "lucide-react";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import SearchResultCard from "@/components/search/SearchResultCard";
import VersionPicker from "@/components/search/VersionPicker";
import { providerLabel } from "@/components/paper/versionLabel";
import { mergeSearchPages } from "@/lib/search-pages";
import QueryError from "@/components/ui/QueryError";
import "./SearchPage.css";

function searchErrorMessage(error: unknown, fallback: string): string {
  const axiosError = error as AxiosError<{ detail?: string }>;
  return axiosError.response?.data?.detail || fallback;
}

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
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery);
  const [unsavedOnly, setUnsavedOnly] = useState(false);
  const [hideDismissed, setHideDismissed] = useState(true);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [detailsKey, setDetailsKey] = useState<string | null>(null);

  const { data: pages, isLoading, isError, error, isFetching, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError } = useInfiniteQuery({
    queryKey: ["search", submitted],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<SearchResult>("/papers/search", {
        params: { q: submitted, page: pageParam, size: 20 },
      });
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.has_more ? lastPage.page + 1 : undefined,
    enabled: !!submitted && !authLoading,
    retry: false,
  });

  const data = useMemo(() => pages ? {
    items: mergeSearchPages(pages.pages),
    providers: [...new Set(pages.pages.flatMap(page => page.providers))],
  } : undefined, [pages]);

  // Loading another page must not reset a user's selected paper version.
  useEffect(() => { setSelectedVersions({}); }, [submitted]);

  // User-scoped overlays: never fired anonymously (no 401 noise).
  const { data: memberships } = useQuery({
    queryKey: ["paper-memberships"],
    queryFn: async () => {
      const { data } = await api.get<PaperMemberships>("/collections/paper-memberships");
      return data;
    },
    enabled: !!data && !!user,
    staleTime: 30_000,
  });

  const { data: dismissedKeys } = useQuery({
    queryKey: ["dismissed-papers"],
    queryFn: async () => {
      const { data } = await api.get<string[]>("/papers/dismissed");
      return data;
    },
    enabled: !!data && !!user,
    staleTime: 30_000,
  });

  const { data: libraryKeys } = useQuery({
    queryKey: ["library-keys"],
    queryFn: () => library.listKeys(),
    enabled: !!data && !!user,
    staleTime: 30_000,
  });

  const dismissedSet = new Set(dismissedKeys ?? []);
  const librarySet = new Set(libraryKeys ?? []);
  const membershipsMap = memberships ?? {};

  const filteredItems = data?.items.filter((item) => {
    const selectedPaper = getSelectedPaper(item, selectedVersions);
    if (hideDismissed && dismissedSet.has(selectedPaper.canonical_key)) return false;
    if (unsavedOnly && membershipsMap[selectedPaper.canonical_key]?.length) return false;
    return true;
  });

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) setSubmitted(query.trim());
  };

  return (
    <div className="search-page">
      <form onSubmit={handleSearch} className="search-bar" role="search">
        <div className="search-input-wrap">
          <Search size={17} className="search-icon" />
          <input
            className="input search-input"
            type="text"
            placeholder={t("search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <button type="submit" className="btn btn-primary">
          {t("search.submit")}
        </button>
      </form>

      {isLoading && <SkeletonCard count={4} />}

      {isError && (
        <QueryError message={searchErrorMessage(error, t("search.errorFallback"))} busy={isFetching} onRetry={() => void (isFetchNextPageError ? fetchNextPage() : refetch())} />
      )}

      {data && (
        <>
          <div className="search-toolbar">
            <p className="search-meta">
              {t("search.resultsMeta", {
                count: data.items.length,
                providers:
                  data.providers.length > 0
                    ? data.providers.map(providerLabel).join(", ")
                    : t("search.noProviders"),
              })}
            </p>
            {user && (
              <div className="search-pills">
                <button
                  type="button"
                  className={`pill ${unsavedOnly ? "active" : ""}`}
                  aria-pressed={unsavedOnly}
                  onClick={() => setUnsavedOnly((v) => !v)}
                >
                  <FolderCheck size={13} />
                  {t("search.unsavedOnly")}
                </button>
                <button
                  type="button"
                  className={`pill ${hideDismissed ? "active" : ""}`}
                  aria-pressed={hideDismissed}
                  onClick={() => setHideDismissed((v) => !v)}
                >
                  <EyeOff size={13} />
                  {t("search.hideDismissed")}
                </button>
              </div>
            )}
          </div>

          <div className="search-list">
            {filteredItems?.map((item) => {
              const selected = getSelectedPaper(item, selectedVersions);
              return (
                <SearchResultCard
                  key={item.kind === "paper" ? item.paper.canonical_key : item.paper_group_key}
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
              );
            })}
          </div>
        </>
      )}

      {filteredItems && filteredItems.length === 0 && (
        <EmptyState
          icon={SearchX}
          title={t("search.emptyTitle")}
          description={t("search.emptyDescription")}
        />
      )}

      {hasNextPage && !isFetchNextPageError && <div className="load-more">
        <button className="btn btn-secondary" disabled={isFetching} onClick={() => void fetchNextPage()}>{t(isFetchingNextPage ? "common.loading" : "common.showMore")}</button>
      </div>}
      <PaperDetailsPanel paperKey={detailsKey} onClose={() => setDetailsKey(null)} />
    </div>
  );
}
