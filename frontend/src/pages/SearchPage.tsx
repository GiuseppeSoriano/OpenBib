import { useState, useRef, useEffect, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import type { SearchResult, PaperMetadata, PaperMemberships, Collection } from "@/types";
import {
  Search, ExternalLink, BookOpen, FolderPlus, GitFork, Check, EyeOff, Undo2, FolderCheck,
} from "lucide-react";
import "./SearchPage.css";

const PROVIDERS = [
  { value: "openalex", label: "OpenAlex" },
  { value: "crossref", label: "Crossref" },
  { value: "arxiv", label: "arXiv" },
  { value: "europepmc", label: "Europe PMC" },
];

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("openalex");
  const [submitted, setSubmitted] = useState("");
  const [unsavedOnly, setUnsavedOnly] = useState(false);
  const [hideDismissed, setHideDismissed] = useState(true);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["search", submitted, provider],
    queryFn: async () => {
      const { data } = await api.get<SearchResult>("/papers/search", {
        params: { q: submitted, provider, page: 1, size: 20 },
      });
      return data;
    },
    enabled: !!submitted,
    retry: 2,
    retryDelay: 1000,
  });

  // Paper memberships: which collections each paper is in (only after search results arrive)
  const { data: memberships } = useQuery({
    queryKey: ["paper-memberships"],
    queryFn: async () => {
      const { data } = await api.get<PaperMemberships>("/collections/paper-memberships");
      return data;
    },
    enabled: !!data,
    staleTime: 30_000,
  });

  // Dismissed paper keys (only after search results arrive)
  const { data: dismissedKeys } = useQuery({
    queryKey: ["dismissed-papers"],
    queryFn: async () => {
      const { data } = await api.get<string[]>("/papers/dismissed");
      return data;
    },
    enabled: !!data,
    staleTime: 30_000,
  });

  const dismissedSet = new Set(dismissedKeys ?? []);
  const membershipsMap = memberships ?? {};

  // Client-side filtering
  const filteredPapers = data?.papers.filter((p) => {
    if (hideDismissed && dismissedSet.has(p.canonical_key)) return false;
    if (unsavedOnly && membershipsMap[p.canonical_key]?.length) return false;
    return true;
  });

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) setSubmitted(query.trim());
  };

  return (
    <div className="search-page">
      <h1>Search papers</h1>

      <form onSubmit={handleSearch} className="search-bar">
        <div className="search-input-wrap">
          <Search size={18} className="search-icon" />
          <input
            className="input search-input"
            type="text"
            placeholder="Search by title, author, DOI, keyword…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <select
          className="input provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {isLoading && <p className="search-status">Searching…</p>}

      {isError && (
        <p className="search-status search-error">
          {(error as any)?.response?.data?.detail ||
            "Search failed. The provider may be temporarily unavailable — please try again."}
        </p>
      )}

      {data && (
        <div className="search-results">
          <p className="search-meta">
            {data.total_count.toLocaleString()} results from{" "}
            <strong>{data.provider}</strong>
          </p>

          {/* Filters */}
          <div className="search-filters">
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={unsavedOnly}
                onChange={(e) => setUnsavedOnly(e.target.checked)}
              />
              <span>Unsaved only</span>
            </label>
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={hideDismissed}
                onChange={(e) => setHideDismissed(e.target.checked)}
              />
              <span>Hide dismissed</span>
            </label>
            {filteredPapers && filteredPapers.length !== data.papers.length && (
              <span className="filter-count">
                Showing {filteredPapers.length} of {data.papers.length}
              </span>
            )}
          </div>

          <div className="paper-list">
            {filteredPapers?.map((paper) => (
              <PaperCard
                key={paper.canonical_key}
                paper={paper}
                savedInCollections={membershipsMap[paper.canonical_key] ?? []}
                isDismissed={dismissedSet.has(paper.canonical_key)}
              />
            ))}
          </div>
        </div>
      )}

      {filteredPapers && filteredPapers.length === 0 && (
        <p className="search-status">No papers found. Try a different query or adjust filters.</p>
      )}
    </div>
  );
}

function PaperCard({
  paper,
  savedInCollections,
  isDismissed,
}: {
  paper: PaperMetadata;
  savedInCollections: string[];
  isDismissed: boolean;
}) {
  const queryClient = useQueryClient();
  const [showCollections, setShowCollections] = useState(false);
  const [sessionAdded, setSessionAdded] = useState<Set<string>>(new Set());
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
        (old ?? []).filter((k) => k !== paper.canonical_key),
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

  // Merge initial + session-added to know which collections already have this paper
  const alreadyInCollection = (collectionId: string) =>
    savedInCollections.includes(collectionId) || sessionAdded.has(collectionId);

  return (
    <div className={`card paper-card${isDismissed ? " paper-card--dismissed" : ""}`}>
      <div className="paper-card-top">
        <div className="paper-title-row">
          <h3 className="paper-title">{paper.title}</h3>
          {isSaved && (
            <span className="badge badge-saved" title="Saved in a collection">
              <FolderCheck size={11} />
              Saved
            </span>
          )}
          {isDismissed && (
            <span className="badge badge-dismissed">Dismissed</span>
          )}
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

      <p className="paper-authors">
        {paper.authors.map((a) => a.name).join(", ")}
      </p>

      <div className="paper-meta">
        {paper.venue && <span>{paper.venue}</span>}
        {paper.publication_date && (
          <span>{paper.publication_date.slice(0, 4)}</span>
        )}
        {paper.cited_by_count != null && (
          <span>{paper.cited_by_count} citations</span>
        )}
        {paper.open_access && <span className="badge">Open Access</span>}
      </div>

      {paper.abstract && (
        <p className="paper-abstract">
          {paper.abstract.length > 300
            ? paper.abstract.slice(0, 300) + "…"
            : paper.abstract}
        </p>
      )}

      {paper.topics.length > 0 && (
        <div className="paper-topics">
          {paper.topics.slice(0, 5).map((t) => (
            <span key={t} className="badge">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="paper-actions">
        <div className="add-to-collection" ref={dropdownRef}>
          <button
            className="btn btn-secondary"
            onClick={() => setShowCollections((s) => !s)}
            title="Add to collection"
          >
            <FolderPlus size={14} />
            Add to collection
          </button>
          {showCollections && (
            <div className="add-to-collection-dropdown">
              {!collections || collections.length === 0 ? (
                <div className="no-collections">
                  No collections yet.{" "}
                  <Link to="/collections" onClick={() => setShowCollections(false)}>
                    Create one
                  </Link>
                </div>
              ) : (
                collections.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => addMutation.mutate(c.id)}
                    disabled={alreadyInCollection(c.id) || addMutation.isPending}
                    className={alreadyInCollection(c.id) ? "already-saved" : ""}
                  >
                    {alreadyInCollection(c.id) ? (
                      <>
                        <Check size={12} style={{ display: "inline", marginRight: 4 }} />
                        Already saved
                      </>
                    ) : (
                      c.name
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
          Explore graph
        </Link>

        {isDismissed ? (
          <button
            className="btn btn-secondary dismiss-btn"
            onClick={() => undismissMutation.mutate()}
            disabled={undismissMutation.isPending}
            title="Undo dismiss"
          >
            <Undo2 size={14} />
            Undo dismiss
          </button>
        ) : (
          <button
            className="btn btn-secondary dismiss-btn"
            onClick={() => dismissMutation.mutate()}
            disabled={dismissMutation.isPending}
            title="Not relevant to my research"
          >
            <EyeOff size={14} />
            Not relevant
          </button>
        )}
      </div>
    </div>
  );
}
