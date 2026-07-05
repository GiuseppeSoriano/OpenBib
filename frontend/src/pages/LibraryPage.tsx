import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { library, zotero } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import type { ZoteroSyncReport } from "@/types";
import ConfirmModal from "@/components/ConfirmModal";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import type { LibraryEntryListItem } from "@/types";
import {
  BookMarked,
  BookUp,
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
  const { t } = useTranslation();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const focusKey = searchParams.get("focus");
  const [expanded, setExpanded] = useState<string | null>(focusKey);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);

  useEffect(() => {
    if (focusKey) setExpanded(focusKey);
  }, [focusKey]);

  const { data: entries, isLoading } = useQuery({
    queryKey: ["library-entries"],
    queryFn: () => library.listEntries({ page: 1, size: 100 }),
  });

  const { data: zoteroStatus } = useQuery({
    queryKey: ["zotero-status"],
    queryFn: () => zotero.getStatus(),
  });

  const zoteroSyncMutation = useMutation({
    mutationFn: () => zotero.syncLibrary(),
    onSuccess: (report: ZoteroSyncReport) => {
      toast(
        t("zotero.report", {
          created: report.items_created,
          updated: report.items_updated,
          skipped: report.items_skipped,
        }),
        report.failures.length > 0 ? "info" : "success",
      );
      if (report.failures.length > 0) {
        toast(t("zotero.reportFailures", { count: report.failures.length }), "error");
      }
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } }).response?.status;
      toast(status === 409 ? t("zotero.notConfigured") : t("zotero.failed"), "error");
    },
  });

  return (
    <div className="library-page">
      <header className="library-header">
        <h1>
          <BookMarked size={20} /> {t("library.title")}
        </h1>
        <p className="library-subtitle">{t("library.subtitle")}</p>
        <div className="library-toolbar">
          <Link to="/graph/library" className="btn btn-secondary">
            <GitFork size={14} /> {t("library.viewGraph")}
          </Link>
          <button
            className="btn btn-secondary"
            onClick={() => zoteroSyncMutation.mutate()}
            disabled={!zoteroStatus?.connected || zoteroSyncMutation.isPending}
            title={zoteroStatus?.connected ? t("zotero.sync") : t("zotero.notConfigured")}
          >
            <BookUp size={14} /> {t("zotero.sync")}
          </button>
        </div>
      </header>

      {errorMessage && (
        <div className="library-error card" onClick={() => setErrorMessage(null)}>
          {errorMessage}
        </div>
      )}

      {isLoading && <SkeletonCard count={4} />}

      {entries && entries.length === 0 && (
        <EmptyState
          icon={BookMarked}
          title={t("library.emptyTitle")}
          description={t("library.emptyDescription")}
          action={
            <Link to="/search" className="btn btn-primary">
              {t("library.searchPapers")}
            </Link>
          }
        />
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
            onOpenDetails={setDetailsKey}
          />
        ))}
      </div>

      <PaperDetailsPanel paperKey={detailsKey} onClose={() => setDetailsKey(null)} />

      {pendingDelete && (
        <ConfirmModal
          title={t("library.deleteTitle")}
          message={t("library.deleteMessage")}
          confirmLabel={t("common.delete")}
          onConfirm={async () => {
            const groupKey = pendingDelete;
            setPendingDelete(null);
            try {
              await library.deleteEntry(groupKey);
            } catch (err: unknown) {
              const status = (err as { response?: { status?: number; data?: { detail?: string } } }).response?.status;
              const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail;
              if (status === 409) {
                setErrorMessage(detail ?? t("library.delete409"));
              } else {
                setErrorMessage(detail ?? t("library.deleteFailed"));
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
  onOpenDetails,
}: {
  item: LibraryEntryListItem;
  expanded: boolean;
  onToggle: () => void;
  onRequestDelete: () => void;
  onError: (msg: string) => void;
  onOpenDetails: (key: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const primary = item.primary_version;
  const title = primary?.title ?? item.paper_group_key;

  return (
    <div className="library-entry-card card">
      <div className="library-entry-top">
        <div className="library-entry-titlerow">
          {primary ? (
            <button
              type="button"
              className="paper-title paper-title-btn"
              onClick={() => onOpenDetails(primary.canonical_key)}
              title={t("paper.viewDetails")}
            >
              {title}
            </button>
          ) : (
            <h3>{title}</h3>
          )}
          {item.version_count > 1 && (
            <span className="badge badge-grouped">
              <Layers3 size={11} /> {t("paper.versions", { count: item.version_count })}
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
              title={t("library.exploreInGraph")}
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
              title={t("paper.doi")}
            >
              <ExternalLink size={14} />
            </a>
          )}
          <button className="btn-ghost" onClick={onRequestDelete} title={t("library.deleteFromLibrary")}>
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
          <span>{t("paper.citations", { count: primary.cited_by_count })}</span>
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
        {expanded ? t("library.hideDetails") : t("library.viewDetails")}
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
  const { t, i18n } = useTranslation();
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
      onError(detail ?? t("library.repinFailed"));
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
        onError(detail ?? t("library.remove409"));
      } else {
        onError(detail ?? t("library.removeFailed"));
      }
    },
  });

  if (isLoading) return <p className="library-status">{t("library.loadingDetails")}</p>;
  if (!entry) return null;

  return (
    <div className="library-entry-detail">
      <h4>{t("library.pinnedVersions")}</h4>
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
                  <span className="badge badge-primary" title={t("library.primaryTitle")}>
                    <Pin size={10} /> {t("library.primary")}
                  </span>
                )}
                {pin.source_provider && (
                  <span className="badge badge-provider">
                    {providerLabel(pin.source_provider)}
                  </span>
                )}
                {stateForPin && (
                  <span className="badge badge-state">{t(`paper.states.${stateForPin.state}`)}</span>
                )}
              </div>
              <div className="library-pin-actions">
                {!isPrimary && (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={repinMutation.isPending}
                    onClick={() => repinMutation.mutate(pin.paper_canonical_key)}
                    title={t("library.repinTitle")}
                  >
                    <Pin size={12} /> {t("library.repin")}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={removeVersionMutation.isPending}
                  onClick={() => {
                    if (window.confirm(t("library.removeConfirm"))) {
                      removeVersionMutation.mutate(pin.paper_canonical_key);
                    }
                  }}
                  title={t("library.removeVersionTitle")}
                >
                  <Trash2 size={12} /> {t("library.removeVersion")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="library-entry-meta">
        {t("library.notesCount", { count: entry.notes_count })} ·{" "}
        {t("library.addedOn", {
          date: new Intl.DateTimeFormat(i18n.language).format(new Date(entry.created_at)),
        })}
      </p>
    </div>
  );
}
