import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { library, zotero } from "@/lib/api";
import { apiErrorMessage, apiStatus } from "@/lib/apiError";
import {
  activeFilterCount,
  parseLibraryParams,
  serializeLibraryParams,
  type LibraryFilterParams,
} from "@/lib/libraryParams";
import { useScrollRestore } from "@/hooks/useScrollRestore";
import { useToast } from "@/components/ui/Toast";
import type { LibraryEntryListItem, ZoteroSyncReport } from "@/types";
import ConfirmModal from "@/components/ConfirmModal";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import QueryError from "@/components/ui/QueryError";
import PaperCard from "@/components/paper/PaperCard";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import AddToCollectionMenu from "@/components/paper/AddToCollectionMenu";
import LibraryFilters from "@/components/library/LibraryFilters";
import {
  AlertTriangle,
  BookMarked,
  BookUp,
  GitFork,
  Layers3,
  RotateCcw,
  SearchX,
  Trash2,
} from "lucide-react";
import "./LibraryPage.css";

const PAGE_SIZE = 25;

/**
 * The personal library: rich, human-readable entries. All low-level
 * details (canonical keys, DOIs, version pins) live behind the details
 * panel — never on the page itself.
 */
export default function LibraryPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const focusKey = searchParams.get("focus");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Keyed by the serialized filters so unrelated URL changes (?focus=) keep
  // the same params object and query.
  const filterKey = serializeLibraryParams(parseLibraryParams(searchParams)).toString();
  const params = useMemo(() => parseLibraryParams(new URLSearchParams(filterKey)), [filterKey]);
  const filtered = activeFilterCount(params) > 0;

  const setParams = useCallback(
    (next: LibraryFilterParams, options: { replace?: boolean } = {}) => {
      setSearchParams((current) => serializeLibraryParams(next, current), options);
    },
    [setSearchParams],
  );
  const resetFilters = useCallback(() => setParams({}), [setParams]);

  const entriesQuery = useInfiniteQuery({
    queryKey: ["library-entries", params],
    queryFn: ({ pageParam }) => library.listEntries({ ...params, page: pageParam, size: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.size < last.total ? last.page + 1 : undefined),
  });
  const pages = entriesQuery.data?.pages;
  const entries = useMemo(() => {
    // An entry saved between two page loads shifts the offsets; never list one twice.
    const seen = new Set<string>();
    const items: LibraryEntryListItem[] = [];
    for (const page of pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.paper_group_key)) continue;
        seen.add(item.paper_group_key);
        items.push(item);
      }
    }
    return items;
  }, [pages]);
  const total = pages && pages.length > 0 ? pages[pages.length - 1]!.total : 0;

  useScrollRestore(`library?${filterKey}`, !!pages);

  // Deep link (?focus=<group_key>): look the entry up directly, since it may
  // be far beyond the loaded pages, and open it once per link.
  const { data: focusEntry } = useQuery({
    queryKey: ["library-entry", focusKey],
    queryFn: () => library.getEntry(focusKey!),
    enabled: !!focusKey,
  });
  const openedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusKey || !focusEntry || openedFocus.current === focusKey) return;
    openedFocus.current = focusKey;
    setDetailsKey(focusEntry.primary_canonical_key);
  }, [focusKey, focusEntry]);

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
      toast(apiStatus(err) === 409 ? t("zotero.notConfigured") : t("zotero.failed"), "error");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (groupKey: string) => library.deleteEntry(groupKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library-entries"] });
      void queryClient.invalidateQueries({ queryKey: ["library-keys"] });
    },
    onError: (err: unknown) => {
      const fallback = apiStatus(err) === 409 ? t("library.delete409") : t("library.deleteFailed");
      toast(apiErrorMessage(err, fallback), "error");
    },
  });

  const loaded = !!pages;
  // A collection filter the user can no longer view answers 404, and a filter
  // value the API rejects 422: offer the reset for both.
  const listStatus = apiStatus(entriesQuery.error);
  const filterRejected = filtered && (listStatus === 404 || listStatus === 422);
  const noMatches = filtered && ((loaded && total === 0) || filterRejected);
  const loadFailed = entriesQuery.isError && !loaded && !filterRejected;
  let countText = "";
  if (loaded && total > 0) {
    countText =
      entries.length < total
        ? t("library.showingOf", { shown: entries.length, total })
        : t("library.resultsCount", { count: total });
  }

  return (
    <div className="library-page">
      <header className="library-header">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>
            {t("library.title")}
          </h1>
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

      <LibraryFilters params={params} onChange={setParams} onReset={resetFilters} />

      <p className="library-count" role="status">
        {countText}
      </p>

      {entriesQuery.isLoading && <SkeletonCard count={4} />}

      {loaded && total === 0 && !filtered && (
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

      {loadFailed && (
        <div role="alert">
          <EmptyState
            icon={AlertTriangle}
            title={t("library.loadFailed")}
            action={
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void entriesQuery.refetch()}
                disabled={entriesQuery.isFetching}
              >
                <RotateCcw size={14} aria-hidden="true" />
                {entriesQuery.isFetching ? t("common.retrying") : t("common.retry")}
              </button>
            }
          />
        </div>
      )}

      {noMatches && (
        <EmptyState
          icon={SearchX}
          title={t("library.noMatches")}
          description={t("library.noMatchesDescription")}
          action={
            <button type="button" className="btn btn-secondary" onClick={resetFilters}>
              {t("common.resetFilters")}
            </button>
          }
        />
      )}

      <div className="library-list">
        {entries.map((item) => (
          <LibraryEntry
            key={item.paper_group_key}
            item={item}
            onOpenDetails={setDetailsKey}
            onRequestDelete={() => setPendingDelete(item.paper_group_key)}
          />
        ))}
      </div>

      {entriesQuery.isFetchNextPageError && (
        <QueryError busy={entriesQuery.isFetching} onRetry={() => void entriesQuery.fetchNextPage()} />
      )}

      {entriesQuery.hasNextPage && !entriesQuery.isFetchNextPageError && (
        <div className="load-more">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void entriesQuery.fetchNextPage()}
            disabled={entriesQuery.isFetchingNextPage}
          >
            {entriesQuery.isFetchingNextPage ? t("common.loading") : t("common.showMore")}
          </button>
        </div>
      )}

      <PaperDetailsPanel
        paperKey={detailsKey}
        onClose={() => setDetailsKey(null)}
        fallbackFocus={() => headingRef.current}
      />

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
  if (!item.resolved || !primary) {
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
