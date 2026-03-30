import { useState, useRef, useEffect, type FormEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import type { SearchResult, PaperMetadata, Collection } from "@/types";
import { Search, ExternalLink, BookOpen, FolderPlus, GitFork, Check } from "lucide-react";
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

  const { data, isLoading } = useQuery({
    queryKey: ["search", submitted, provider],
    queryFn: async () => {
      const { data } = await api.get<SearchResult>("/papers/search", {
        params: { q: submitted, provider, page: 1, size: 20 },
      });
      return data;
    },
    enabled: !!submitted,
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

      {data && (
        <div className="search-results">
          <p className="search-meta">
            {data.total_count.toLocaleString()} results from{" "}
            <strong>{data.provider}</strong>
          </p>

          <div className="paper-list">
            {data.papers.map((paper) => (
              <PaperCard key={paper.canonical_key} paper={paper} />
            ))}
          </div>
        </div>
      )}

      {data && data.papers.length === 0 && (
        <p className="search-status">No papers found. Try a different query or provider.</p>
      )}
    </div>
  );
}

function PaperCard({ paper }: { paper: PaperMetadata }) {
  const [showCollections, setShowCollections] = useState(false);
  const [addedTo, setAddedTo] = useState<Set<string>>(new Set());
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
      setAddedTo((prev) => new Set(prev).add(collectionId));
    },
  });

  return (
    <div className="card paper-card">
      <div className="paper-card-top">
        <h3 className="paper-title">{paper.title}</h3>
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
                    disabled={addedTo.has(c.id) || addMutation.isPending}
                  >
                    {addedTo.has(c.id) ? (
                      <>
                        <Check size={12} style={{ display: "inline", marginRight: 4 }} />
                        Added to {c.name}
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
      </div>
    </div>
  );
}
