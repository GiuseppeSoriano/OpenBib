import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { library, zotero } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import type { LibraryEntryListItem, ZoteroSyncReport } from "@/types";
import QueryError from "@/components/ui/QueryError";
import ConfirmModal from "@/components/ConfirmModal";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import PaperCard from "@/components/paper/PaperCard";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import AddToCollectionMenu from "@/components/paper/AddToCollectionMenu";
import { BookMarked, BookUp, GitFork, Layers3, Trash2 } from "lucide-react";
import "./LibraryPage.css";

/**
 * The personal library: rich, human-readable entries. All low-level
 * details (canonical keys, DOIs, version pins) live behind the details
 * panel — never on the page itself.
 */
export default function LibraryPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const focusKey = searchParams.get("focus");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);

  const { data, isLoading, isError, isFetching, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = useInfiniteQuery({
    queryKey: ["library-entries"],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => library.listEntries({ page: pageParam, size: 25 }),
    getNextPageParam: (lastPage, _pages, page) => lastPage.length === 25 ? page + 1 : undefined,
  });
  const entries = useMemo(() => data ? Array.from(new Map(data.pages.flat().map(entry => [entry.paper_group_key, entry])).values()) : undefined, [data]);

  const { data: focusedEntry } = useQuery({
    queryKey: ["library-entry", focusKey],
    queryFn: () => library.getEntry(focusKey!),
    enabled: !!focusKey && !!entries && !entries.some(entry => entry.paper_group_key === focusKey),
  });

  // A deep link can target an entry beyond the pages loaded so far.
  useEffect(() => {
    if (!focusKey || !entries) return;
    const entry = entries.find((e) => e.paper_group_key === focusKey) ?? focusedEntry;
    if (entry) setDetailsKey(entry.primary_canonical_key);
  }, [focusKey, entries, focusedEntry]);

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

  const deleteMutation = useMutation({
    mutationFn: (groupKey: string) => library.deleteEntry(groupKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library-entries"] });
      void queryClient.invalidateQueries({ queryKey: ["library-keys"] });
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } }).response?.status;
      const detail = (err as { response?: { data?: { detail?: string } } }).response?.data
        ?.detail;
      if (status === 409) {
        toast(detail ?? t("library.delete409"), "error");
      } else {
        toast(detail ?? t("library.deleteFailed"), "error");
      }
    },
  });

  return (
    <div className="library-page">
      <header className="library-header">
        <div>
          <h1>{t("library.title")}</h1>
          <p className="library-subtitle">{t("library.subtitle")}</p>
        </div>
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

      {isLoading && <SkeletonCard count={4} />}
      {isError && <QueryError onRetry={() => void (isFetchNextPageError ? fetchNextPage() : refetch())} busy={isFetching} />}

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
          <LibraryEntry
            key={item.paper_group_key}
            item={item}
            onOpenDetails={setDetailsKey}
            onRequestDelete={() => setPendingDelete(item.paper_group_key)}
          />
        ))}
      </div>

      {hasNextPage && !isFetchNextPageError && <div className="load-more">
        <button className="btn btn-secondary" disabled={isFetching} onClick={() => void fetchNextPage()}>{t(isFetchingNextPage ? "common.loading" : "common.showMore")}</button>
      </div>}
      <PaperDetailsPanel paperKey={detailsKey} onClose={() => setDetailsKey(null)} />

      {pendingDelete && (
        <ConfirmModal
          title={t("library.deleteTitle")}
          message={t("library.deleteMessage")}
          confirmLabel={t("common.delete")}
          onConfirm={() => {
            deleteMutation.mutate(pendingDelete);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function LibraryEntry({
  item,
  onOpenDetails,
  onRequestDelete,
}: {
  item: LibraryEntryListItem;
  onOpenDetails: (key: string) => void;
  onRequestDelete: () => void;
}) {
  const { t } = useTranslation();
  const primary = item.primary_version;

  // Entries without a metadata snapshot degrade to a minimal card that
  // still opens the details panel (which can hydrate live).
  if (!primary) {
    return (
      <div className="card library-entry-fallback">
        <button
          type="button"
          className="paper-title paper-title-btn"
          onClick={() => onOpenDetails(item.primary_canonical_key)}
        >
          {t("paper.detailsTitle")}
        </button>
      </div>
    );
  }

  return (
    <PaperCard
      paper={primary}
      onOpenDetails={() => onOpenDetails(item.primary_canonical_key)}
      showAbstract={false}
      headerBadges={
        item.version_count > 1 ? (
          <span className="badge badge--neutral">
            <Layers3 size={11} /> {t("paper.versions", { count: item.version_count })}
          </span>
        ) : undefined
      }
      actions={
        <>
          <AddToCollectionMenu canonicalKey={item.primary_canonical_key} />
          <Link
            to={`/graph/${encodeURIComponent(item.primary_canonical_key)}`}
            className="btn btn-secondary"
          >
            <GitFork size={14} />
            {t("paper.exploreGraph")}
          </Link>
          <button
            type="button"
            className="btn-ghost library-delete"
            onClick={onRequestDelete}
            title={t("library.deleteFromLibrary")}
          >
            <Trash2 size={14} />
          </button>
        </>
      }
    >
      {item.tags.length > 0 && (
        <div className="library-entry-tags">
          {item.tags.map((tag) => (
            <span key={tag} className="paper-tag">
              {tag}
            </span>
          ))}
        </div>
      )}
    </PaperCard>
  );
}
