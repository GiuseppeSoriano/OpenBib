import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AxiosError } from "axios";
import api, { library } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type {
  PaperMemberships,
  PaperMetadata,
  SearchPaperGroupItem,
  SearchResult,
  SearchResultItem,
} from "@/types";
import {
  BookMarked,
  ChevronDown,
  EyeOff,
  FolderCheck,
  GitFork,
  Layers3,
  Search,
  SearchX,
  Undo2,
} from "lucide-react";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import PaperCard, { providerLabel } from "@/components/paper/PaperCard";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import AddToCollectionMenu from "@/components/paper/AddToCollectionMenu";
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
  const selectedKey = selectedVersions[item.paper_group_key] ?? item.selected_version.canonical_key;
  return item.versions.find((paper) => paper.canonical_key === selectedKey) ?? item.selected_version;
}

export default function SearchPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery);
  const [unsavedOnly, setUnsavedOnly] = useState(false);
  const [hideDismissed, setHideDismissed] = useState(true);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [detailsKey, setDetailsKey] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["search", submitted],
    queryFn: async () => {
      const { data } = await api.get<SearchResult>("/papers/search", {
        params: { q: submitted, page: 1, size: 20 },
      });
      return data;
    },
    enabled: !!submitted,
    retry: 2,
    retryDelay: 1000,
  });

  useEffect(() => {
    if (!data) {
      setSelectedVersions({});
      return;
    }
    const nextSelections: Record<string, string> = {};
    for (const item of data.items) {
      if (item.kind === "paper_group") {
        nextSelections[item.paper_group_key] = item.selected_version.canonical_key;
      }
    }
    setSelectedVersions(nextSelections);
  }, [data]);

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
      <h1>{t("search.title")}</h1>

      <form onSubmit={handleSearch} className="search-bar">
        <div className="search-input-wrap">
          <Search size={18} className="search-icon" />
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
        <p className="search-status search-error">
          {searchErrorMessage(error, t("search.errorFallback"))}
        </p>
      )}

      {data && (
        <div className="search-results">
          <p className="search-meta">
            {t("search.resultsMeta", {
              count: data.total_count,
              providers:
                data.providers.length > 0
                  ? data.providers.map(providerLabel).join(", ")
                  : t("search.noProviders"),
            })}
            {data.raw_total_count !== data.total_count && (
              <> · {t("search.rawMatches", { count: data.raw_total_count })}</>
            )}
          </p>

          <div className="search-filters">
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={unsavedOnly}
                onChange={(e) => setUnsavedOnly(e.target.checked)}
              />
              <span>{t("search.unsavedOnly")}</span>
            </label>
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={hideDismissed}
                onChange={(e) => setHideDismissed(e.target.checked)}
              />
              <span>{t("search.hideDismissed")}</span>
            </label>
            {filteredItems && filteredItems.length !== data.items.length && (
              <span className="filter-count">
                {t("search.showingOf", { shown: filteredItems.length, total: data.items.length })}
              </span>
            )}
          </div>

          <div className="paper-list">
            {filteredItems?.map((item) => {
              if (item.kind === "paper") {
                return (
                  <SearchPaperCard
                    key={item.paper.canonical_key}
                    paper={item.paper}
                    providerSources={item.paper.provider_sources ?? []}
                    savedInCollections={membershipsMap[item.paper.canonical_key] ?? []}
                    isDismissed={dismissedSet.has(item.paper.canonical_key)}
                    inLibrary={librarySet.has(item.paper.paper_group_key)}
                    onOpenDetails={setDetailsKey}
                  />
                );
              }

              const selected = getSelectedPaper(item, selectedVersions);
              return (
                <PaperGroupCard
                  key={item.paper_group_key}
                  item={item}
                  selectedPaper={selected}
                  onSelectVersion={(paper) =>
                    setSelectedVersions((current) => ({
                      ...current,
                      [item.paper_group_key]: paper.canonical_key,
                    }))
                  }
                  savedInCollections={membershipsMap[selected.canonical_key] ?? []}
                  isDismissed={dismissedSet.has(selected.canonical_key)}
                  inLibrary={librarySet.has(item.paper_group_key)}
                  onOpenDetails={setDetailsKey}
                />
              );
            })}
          </div>
        </div>
      )}

      {filteredItems && filteredItems.length === 0 && (
        <EmptyState
          icon={SearchX}
          title={t("search.emptyTitle")}
          description={t("search.emptyDescription")}
        />
      )}

      <PaperDetailsPanel paperKey={detailsKey} onClose={() => setDetailsKey(null)} />
    </div>
  );
}

function PaperGroupCard({
  item,
  selectedPaper,
  onSelectVersion,
  savedInCollections,
  isDismissed,
  inLibrary,
  onOpenDetails,
}: {
  item: SearchPaperGroupItem;
  selectedPaper: PaperMetadata;
  onSelectVersion: (paper: PaperMetadata) => void;
  savedInCollections: string[];
  isDismissed: boolean;
  inLibrary: boolean;
  onOpenDetails: (key: string) => void;
}) {
  const { t } = useTranslation();
  const [showVersions, setShowVersions] = useState(false);

  return (
    <div className="paper-group-card">
      <div className="paper-group-toolbar">
        <button
          type="button"
          className="group-toggle"
          onClick={() => setShowVersions((current) => !current)}
        >
          <Layers3 size={14} />
          {t("paper.versions", { count: item.version_count })}
          <ChevronDown size={14} className={showVersions ? "group-toggle-icon open" : "group-toggle-icon"} />
        </button>
      </div>

      {showVersions && (
        <div className="version-list">
          {item.versions.map((version) => {
            const isActive = version.canonical_key === selectedPaper.canonical_key;
            return (
              <button
                type="button"
                key={version.canonical_key}
                className={`version-chip${isActive ? " active" : ""}`}
                onClick={() => onSelectVersion(version)}
              >
                <span>{version.version || version.publication_date?.slice(0, 4) || t("paper.undated")}</span>
                <span>{providerLabel(version.provider_source)}</span>
              </button>
            );
          })}
        </div>
      )}

      <SearchPaperCard
        paper={selectedPaper}
        providerSources={item.provider_sources ?? selectedPaper.provider_sources ?? []}
        savedInCollections={savedInCollections}
        isDismissed={isDismissed}
        inLibrary={inLibrary}
        onOpenDetails={onOpenDetails}
        className="paper-card--grouped"
        headerBadges={[
          <span key="versions" className="badge badge-grouped">
            <Layers3 size={11} />
            {t("paper.versionsGrouped", { count: item.version_count })}
          </span>,
        ]}
      />
    </div>
  );
}

function SearchPaperCard({
  paper,
  providerSources,
  savedInCollections,
  isDismissed,
  inLibrary,
  onOpenDetails,
  className = "",
  headerBadges = [],
}: {
  paper: PaperMetadata;
  providerSources: string[];
  savedInCollections: string[];
  isDismissed: boolean;
  inLibrary: boolean;
  onOpenDetails: (key: string) => void;
  className?: string;
  headerBadges?: ReactNode[];
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [sessionLibrarySaved, setSessionLibrarySaved] = useState(false);

  useEffect(() => {
    setSessionLibrarySaved(false);
  }, [paper.paper_group_key]);

  const saveToLibraryMutation = useMutation({
    mutationFn: async () => {
      await library.ensureEntry({
        paper_group_key: paper.paper_group_key,
        paper_canonical_key: paper.canonical_key,
        source_provider: paper.provider_source,
      });
    },
    onSuccess: () => {
      setSessionLibrarySaved(true);
      void queryClient.invalidateQueries({ queryKey: ["library-keys"] });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/papers/${encodeURIComponent(paper.canonical_key)}/dismiss`);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["dismissed-papers"] });
      const prev = queryClient.getQueryData<string[]>(["dismissed-papers"]);
      queryClient.setQueryData<string[]>(["dismissed-papers"], (old) => [
        ...(old ?? []),
        paper.canonical_key,
      ]);
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["dismissed-papers"], ctx.prev);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["dismissed-papers"] });
    },
  });

  const undismissMutation = useMutation({
    mutationFn: async () => {
      await api.delete(`/papers/${encodeURIComponent(paper.canonical_key)}/dismiss`);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["dismissed-papers"] });
      const prev = queryClient.getQueryData<string[]>(["dismissed-papers"]);
      queryClient.setQueryData<string[]>(["dismissed-papers"], (old) =>
        (old ?? []).filter((key) => key !== paper.canonical_key),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["dismissed-papers"], ctx.prev);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["dismissed-papers"] });
    },
  });

  const isSaved = savedInCollections.length > 0;
  const inLibraryNow = inLibrary || sessionLibrarySaved;

  return (
    <PaperCard
      paper={paper}
      providerSources={providerSources}
      onOpenDetails={() => onOpenDetails(paper.canonical_key)}
      className={`${isDismissed ? "paper-card--dismissed" : ""} ${className}`.trim()}
      headerBadges={
        <>
          {headerBadges}
          {isSaved && (
            <span className="badge badge-saved" title={t("paper.savedTitle")}>
              <FolderCheck size={11} />
              {t("paper.saved")}
            </span>
          )}
          {inLibraryNow && (
            <span className="badge badge-library" title={t("paper.inLibraryTitle")}>
              <BookMarked size={11} />
              {t("paper.inLibrary")}
            </span>
          )}
          {isDismissed && <span className="badge badge-dismissed">{t("paper.dismissed")}</span>}
        </>
      }
      actions={
        <>
        {user && (
        <>
        <button
          type="button"
          className="btn btn-secondary save-to-library-btn"
          onClick={() => saveToLibraryMutation.mutate()}
          disabled={inLibraryNow || saveToLibraryMutation.isPending}
          title={inLibraryNow ? t("paper.alreadyInLibrary") : t("paper.saveToLibraryTitle")}
        >
          <BookMarked size={14} />
          {inLibraryNow ? t("paper.inLibrary") : t("paper.saveToLibrary")}
        </button>

        <AddToCollectionMenu
          canonicalKey={paper.canonical_key}
          savedInCollections={savedInCollections}
        />
        </>
        )}

        <Link
          to={`/graph/${encodeURIComponent(paper.canonical_key)}`}
          className="btn btn-secondary explore-graph-link"
        >
          <GitFork size={14} />
          {t("paper.exploreGraph")}
        </Link>

        {user &&
          (isDismissed ? (
            <button
              className="btn btn-secondary dismiss-btn"
              onClick={() => undismissMutation.mutate()}
              disabled={undismissMutation.isPending}
              title={t("paper.undoDismiss")}
            >
              <Undo2 size={14} />
              {t("paper.undoDismiss")}
            </button>
          ) : (
            <button
              className="btn btn-secondary dismiss-btn"
              onClick={() => dismissMutation.mutate()}
              disabled={dismissMutation.isPending}
              title={t("paper.notRelevantTitle")}
            >
              <EyeOff size={14} />
              {t("paper.notRelevant")}
            </button>
          ))}
        </>
      }
    />
  );
}
