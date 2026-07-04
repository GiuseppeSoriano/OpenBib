import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AxiosError } from "axios";
import api, { library } from "@/lib/api";
import type {
  Collection,
  PaperMemberships,
  PaperMetadata,
  SearchPaperGroupItem,
  SearchResult,
  SearchResultItem,
} from "@/types";
import {
  BookMarked,
  BookOpen,
  Check,
  ChevronDown,
  ExternalLink,
  EyeOff,
  FolderCheck,
  FolderPlus,
  GitFork,
  Layers3,
  Search,
  SearchX,
  Undo2,
} from "lucide-react";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import "./SearchPage.css";

const PROVIDER_LABELS: Record<string, string> = {
  openalex: "OpenAlex",
  crossref: "Crossref",
  arxiv: "arXiv",
  europepmc: "Europe PMC",
};

function providerLabel(name: string): string {
  return PROVIDER_LABELS[name] ?? name;
}

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
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [unsavedOnly, setUnsavedOnly] = useState(false);
  const [hideDismissed, setHideDismissed] = useState(true);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});

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

  const { data: memberships } = useQuery({
    queryKey: ["paper-memberships"],
    queryFn: async () => {
      const { data } = await api.get<PaperMemberships>("/collections/paper-memberships");
      return data;
    },
    enabled: !!data,
    staleTime: 30_000,
  });

  const { data: dismissedKeys } = useQuery({
    queryKey: ["dismissed-papers"],
    queryFn: async () => {
      const { data } = await api.get<string[]>("/papers/dismissed");
      return data;
    },
    enabled: !!data,
    staleTime: 30_000,
  });

  const { data: libraryKeys } = useQuery({
    queryKey: ["library-keys"],
    queryFn: () => library.listKeys(),
    enabled: !!data,
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
                  <PaperCard
                    key={item.paper.canonical_key}
                    paper={item.paper}
                    providerSources={item.paper.provider_sources ?? []}
                    savedInCollections={membershipsMap[item.paper.canonical_key] ?? []}
                    isDismissed={dismissedSet.has(item.paper.canonical_key)}
                    inLibrary={librarySet.has(item.paper.paper_group_key)}
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
}: {
  item: SearchPaperGroupItem;
  selectedPaper: PaperMetadata;
  onSelectVersion: (paper: PaperMetadata) => void;
  savedInCollections: string[];
  isDismissed: boolean;
  inLibrary: boolean;
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

      <PaperCard
        paper={selectedPaper}
        providerSources={item.provider_sources ?? selectedPaper.provider_sources ?? []}
        savedInCollections={savedInCollections}
        isDismissed={isDismissed}
        inLibrary={inLibrary}
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

function PaperCard({
  paper,
  providerSources,
  savedInCollections,
  isDismissed,
  inLibrary,
  className = "",
  headerBadges = [],
}: {
  paper: PaperMetadata;
  providerSources: string[];
  savedInCollections: string[];
  isDismissed: boolean;
  inLibrary: boolean;
  className?: string;
  headerBadges?: ReactNode[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showCollections, setShowCollections] = useState(false);
  const [sessionAdded, setSessionAdded] = useState<Set<string>>(new Set());
  const [sessionLibrarySaved, setSessionLibrarySaved] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowCollections(false);
      }
    };
    if (showCollections) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showCollections]);

  useEffect(() => {
    setSessionLibrarySaved(false);
  }, [paper.paper_group_key]);

  const { data: collections } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data } = await api.get<Collection[]>("/collections");
      return data;
    },
    enabled: showCollections,
  });

  const addMutation = useMutation({
    mutationFn: async (collectionId: string) => {
      await api.post(`/collections/${collectionId}/papers`, {
        paper_canonical_key: paper.canonical_key,
      });
    },
    onSuccess: (_data, collectionId) => {
      setSessionAdded((prev) => new Set(prev).add(collectionId));
      void queryClient.invalidateQueries({ queryKey: ["paper-memberships"] });
      void queryClient.invalidateQueries({ queryKey: ["library-keys"] });
    },
  });

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

  const isSaved = savedInCollections.length > 0 || sessionAdded.size > 0;
  const inLibraryNow = inLibrary || sessionLibrarySaved;

  const alreadyInCollection = (collectionId: string) =>
    savedInCollections.includes(collectionId) || sessionAdded.has(collectionId);

  return (
    <div className={`card paper-card${isDismissed ? " paper-card--dismissed" : ""} ${className}`.trim()}>
      {providerSources.length > 0 && (
        <div className="provider-badges">
          {providerSources.map((source) => (
            <span key={source} className="badge badge-provider">
              {providerLabel(source)}
            </span>
          ))}
        </div>
      )}
      <div className="paper-card-top">
        <div className="paper-title-row">
          <h3 className="paper-title">{paper.title}</h3>
          {headerBadges}
          {paper.version && <span className="badge badge-version">{paper.version}</span>}
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
        </div>
        <div className="paper-links">
          {paper.doi && (
            <a
              href={`https://doi.org/${paper.doi}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
              title="DOI"
            >
              <ExternalLink size={14} />
            </a>
          )}
          {paper.pdf_url && (
            <a
              href={paper.pdf_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
              title="PDF"
            >
              <BookOpen size={14} />
            </a>
          )}
        </div>
      </div>

      <p className="paper-authors">{paper.authors.map((author) => author.name).join(", ")}</p>

      <div className="paper-meta">
        {paper.venue && <span>{paper.venue}</span>}
        {paper.publication_date && <span>{paper.publication_date.slice(0, 4)}</span>}
        {paper.cited_by_count != null && (
          <span>{t("paper.citations", { count: paper.cited_by_count })}</span>
        )}
        {paper.open_access && <span className="badge">{t("paper.openAccess")}</span>}
      </div>

      {paper.abstract && (
        <p className="paper-abstract">
          {paper.abstract.length > 300 ? `${paper.abstract.slice(0, 300)}…` : paper.abstract}
        </p>
      )}

      {paper.topics.length > 0 && (
        <div className="paper-topics">
          {paper.topics.slice(0, 5).map((topic) => (
            <span key={topic} className="badge">
              {topic}
            </span>
          ))}
        </div>
      )}

      <div className="paper-actions">
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

        <div className="add-to-collection" ref={dropdownRef}>
          <button
            className="btn btn-secondary"
            onClick={() => setShowCollections((current) => !current)}
            title={t("paper.addToCollection")}
          >
            <FolderPlus size={14} />
            {t("paper.addToCollection")}
          </button>
          {showCollections && (
            <div className="add-to-collection-dropdown">
              {!collections || collections.length === 0 ? (
                <div className="no-collections">
                  {t("paper.noCollectionsYet")}{" "}
                  <Link to="/collections" onClick={() => setShowCollections(false)}>
                    {t("paper.createOne")}
                  </Link>
                </div>
              ) : (
                collections.map((collection) => (
                  <button
                    key={collection.id}
                    onClick={() => addMutation.mutate(collection.id)}
                    disabled={alreadyInCollection(collection.id) || addMutation.isPending}
                    className={alreadyInCollection(collection.id) ? "already-saved" : ""}
                  >
                    {alreadyInCollection(collection.id) ? (
                      <>
                        <Check size={12} style={{ display: "inline", marginRight: 4 }} />
                        {t("paper.alreadySaved")}
                      </>
                    ) : (
                      collection.name
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <Link
          to={`/graph/${encodeURIComponent(paper.canonical_key)}`}
          className="btn btn-secondary explore-graph-link"
        >
          <GitFork size={14} />
          {t("paper.exploreGraph")}
        </Link>

        {isDismissed ? (
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
        )}
      </div>
    </div>
  );
}
