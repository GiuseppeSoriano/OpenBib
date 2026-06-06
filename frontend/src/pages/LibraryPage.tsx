import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { library } from "@/lib/api";
import ConfirmModal from "@/components/ConfirmModal";
import type { LibraryEntryListItem } from "@/types";
import {
  BookMarked,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitFork,
  Layers3,
  Pin,
  Trash2,
} from "lucide-react";
import "./LibraryPage.css";

const PROVIDER_LABELS: Record<string, string> = {
  openalex: "OpenAlex",
  crossref: "Crossref",
  arxiv: "arXiv",
  europepmc: "Europe PMC",
};

function providerLabel(name: string | null | undefined): string {
  if (!name) return "Unknown";
  return PROVIDER_LABELS[name] ?? name;
}

export default function LibraryPage() {
  const [searchParams] = useSearchParams();
  const focusKey = searchParams.get("focus");
  const [expanded, setExpanded] = useState<string | null>(focusKey);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (focusKey) setExpanded(focusKey);
  }, [focusKey]);

  const { data: entries, isLoading } = useQuery({
    queryKey: ["library-entries"],
    queryFn: () => library.listEntries({ page: 1, size: 100 }),
  });

  return (
    <div className="library-page">
      <header className="library-header">
        <h1>
          <BookMarked size={20} /> Library
        </h1>
        <p className="library-subtitle">
          Your persistent archive of saved papers. Notes and tags anchor here so
          they survive moving papers between collections and version upgrades.
        </p>
        <div className="library-toolbar">
          <Link to="/graph/library" className="btn btn-secondary">
            <GitFork size={14} /> View citation graph
          </Link>
        </div>
      </header>

      {errorMessage && (
        <div className="library-error card" onClick={() => setErrorMessage(null)}>
          {errorMessage}
        </div>
      )}

      {isLoading && <p className="library-status">Loading…</p>}

      {entries && entries.length === 0 && (
        <p className="library-status">
          Your library is empty. Save a paper from <Link to="/search">Search</Link> or
          add one to a <Link to="/collections">collection</Link> to start filling it.
        </p>
      )}

      <div className="library-list">
        {entries?.map((item) => (
          <LibraryEntryCard
            key={item.paper_group_key}
            item={item}
            expanded={expanded === item.paper_group_key}
            onToggle={() =>
              setExpanded((current) =>
                current === item.paper_group_key ? null : item.paper_group_key,
              )
            }
            onRequestDelete={() => setPendingDelete(item.paper_group_key)}
            onError={(msg) => setErrorMessage(msg)}
          />
        ))}
      </div>

      {pendingDelete && (
        <ConfirmModal
          title="Delete from Library"
          message="This deletes the entry, all pinned versions, and any notes/tags/states anchored to this paper. This cannot be undone. Continue?"
          confirmLabel="Delete"
          onConfirm={async () => {
            const groupKey = pendingDelete;
            setPendingDelete(null);
            try {
              await library.deleteEntry(groupKey);
            } catch (err: unknown) {
              const status = (err as { response?: { status?: number; data?: { detail?: string } } }).response?.status;
              const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail;
              if (status === 409) {
                setErrorMessage(
                  detail ??
                    "Cannot delete this library entry — at least one pinned version is still in a collection. Remove it from the relevant collection(s) first.",
                );
              } else {
                setErrorMessage(detail ?? "Delete failed");
              }
            }
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function LibraryEntryCard({
  item,
  expanded,
  onToggle,
  onRequestDelete,
  onError,
}: {
  item: LibraryEntryListItem;
  expanded: boolean;
  onToggle: () => void;
  onRequestDelete: () => void;
  onError: (msg: string) => void;
}) {
  const queryClient = useQueryClient();
  const primary = item.primary_version;
  const title = primary?.title ?? item.paper_group_key;

  return (
    <div className="library-entry-card card">
      <div className="library-entry-top">
        <div className="library-entry-titlerow">
          <h3>{title}</h3>
          {item.version_count > 1 && (
            <span className="badge badge-grouped">
              <Layers3 size={11} /> {item.version_count} versions
            </span>
          )}
          {primary?.version && (
            <span className="badge badge-version">{primary.version}</span>
          )}
        </div>
        <div className="library-entry-actions">
          {primary && (
            <Link
              to={`/graph/${encodeURIComponent(primary.canonical_key)}`}
              className="btn-ghost"
              title="Explore in graph"
            >
              <GitFork size={14} />
            </Link>
          )}
          {primary?.doi && (
            <a
              href={`https://doi.org/${primary.doi}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
              title="DOI"
            >
              <ExternalLink size={14} />
            </a>
          )}
          <button className="btn-ghost" onClick={onRequestDelete} title="Delete from Library">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {primary && (
        <p className="library-entry-authors">
          {primary.authors.map((a) => a.name).join(", ")}
        </p>
      )}

      <div className="library-entry-meta">
        {primary?.venue && <span>{primary.venue}</span>}
        {primary?.publication_date && <span>{primary.publication_date.slice(0, 4)}</span>}
        {primary?.cited_by_count != null && (
          <span>{primary.cited_by_count} citations</span>
        )}
        {primary?.provider_sources && primary.provider_sources.length > 0 && (
          <span className="library-entry-providers">
            {primary.provider_sources.map((p) => providerLabel(p)).join(" · ")}
          </span>
        )}
      </div>

      {item.tags.length > 0 && (
        <div className="library-entry-tags">
          {item.tags.map((tag) => (
            <span key={tag} className="paper-tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      <button className="library-entry-toggle btn-ghost" onClick={onToggle}>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {expanded ? "Hide details" : "View details"}
      </button>

      {expanded && (
        <LibraryEntryDetail
          groupKey={item.paper_group_key}
          onError={onError}
          onRefresh={() => {
            void queryClient.invalidateQueries({ queryKey: ["library-entries"] });
            void queryClient.invalidateQueries({ queryKey: ["library-keys"] });
          }}
        />
      )}
    </div>
  );
}

function LibraryEntryDetail({
  groupKey,
  onError,
  onRefresh,
}: {
  groupKey: string;
  onError: (msg: string) => void;
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const detailKey = ["library-entry", groupKey] as const;

  const { data: entry, isLoading } = useQuery({
    queryKey: detailKey,
    queryFn: () => library.getEntry(groupKey),
  });

  const repinMutation = useMutation({
    mutationFn: (canonicalKey: string) => library.repinPrimary(groupKey, canonicalKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: detailKey });
      onRefresh();
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail;
      onError(detail ?? "Re-pin failed");
    },
  });

  const removeVersionMutation = useMutation({
    mutationFn: (canonicalKey: string) => library.removeVersion(groupKey, canonicalKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: detailKey });
      onRefresh();
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } }).response?.status;
      const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail;
      if (status === 409) {
        onError(
          detail ??
            "Cannot remove this version — it is still referenced by one or more collections. Remove it from those collections first.",
        );
      } else {
        onError(detail ?? "Remove failed");
      }
    },
  });

  if (isLoading) return <p className="library-status">Loading details…</p>;
  if (!entry) return null;

  return (
    <div className="library-entry-detail">
      <h4>Pinned versions</h4>
      <div className="library-pin-list">
        {entry.pinned_versions.map((pin) => {
          const isPrimary = pin.paper_canonical_key === entry.primary_canonical_key;
          const stateForPin = entry.states.find(
            (s) => s.paper_canonical_key === pin.paper_canonical_key,
          );
          return (
            <div key={pin.paper_canonical_key} className="library-pin">
              <div className="library-pin-row">
                <code className="library-pin-key" title={pin.paper_canonical_key}>
                  {pin.paper_canonical_key}
                </code>
                {isPrimary && (
                  <span className="badge badge-primary" title="Default version shown for this entry">
                    <Pin size={10} /> Primary
                  </span>
                )}
                {pin.source_provider && (
                  <span className="badge badge-provider">
                    {providerLabel(pin.source_provider)}
                  </span>
                )}
                {stateForPin && (
                  <span className="badge badge-state">{stateForPin.state.replace("_", " ")}</span>
                )}
              </div>
              <div className="library-pin-actions">
                {!isPrimary && (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={repinMutation.isPending}
                    onClick={() => repinMutation.mutate(pin.paper_canonical_key)}
                    title="Make this version the default shown"
                  >
                    <Pin size={12} /> Re-pin as primary
                  </button>
                )}
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={removeVersionMutation.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove this version pin? Will fail with 409 if "${pin.paper_canonical_key}" is still in any of your collections.`,
                      )
                    ) {
                      removeVersionMutation.mutate(pin.paper_canonical_key);
                    }
                  }}
                  title="Remove this version pin"
                >
                  <Trash2 size={12} /> Remove version
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="library-entry-meta">
        {entry.notes_count} note{entry.notes_count !== 1 ? "s" : ""} · Added{" "}
        {new Date(entry.created_at).toLocaleDateString()}
      </p>
    </div>
  );
}
