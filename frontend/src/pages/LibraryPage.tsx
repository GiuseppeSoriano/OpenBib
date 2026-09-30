import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { library } from "@/lib/api";
import { apiErrorCode, apiErrorDetail, apiErrorText, apiStatus } from "@/lib/apiError";
import {
  activeFilterCount,
  parseLibraryParams,
  serializeLibraryParams,
  type LibraryFilterParams,
} from "@/lib/libraryParams";
import { useScrollRestore } from "@/hooks/useScrollRestore";
import { useToast } from "@/components/ui/Toast";
import type { BlockingCollection, LibraryEntryListItem, LibraryResolveResult } from "@/types";
import ConfirmModal from "@/components/ConfirmModal";
import Modal from "@/components/ui/Modal";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import QueryError from "@/components/ui/QueryError";
import PaperCard from "@/components/paper/PaperCard";
import UnresolvedPaperCard from "@/components/paper/UnresolvedPaperCard";
import ZoteroSyncButton from "@/components/zotero/ZoteroSyncButton";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import AddToCollectionMenu from "@/components/paper/AddToCollectionMenu";
import LibraryFilters from "@/components/library/LibraryFilters";
import {
  AlertTriangle,
  BookMarked,
  Download,
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
 * panel — except the stored identifier of a paper whose details are
 * missing, which its recovery card needs to show.
 */
export default function LibraryPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const focusKey = searchParams.get("focus");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [blockedDelete, setBlockedDelete] = useState<{
    groupKey: string;
    collections: BlockingCollection[];
  } | null>(null);
  const [details, setDetails] = useState<{ key: string; unresolved: boolean } | null>(null);
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
    setDetails({ key: focusEntry.primary_canonical_key, unresolved: !focusEntry.primary_version });
  }, [focusKey, focusEntry]);

  const deleteMutation = useMutation({
    mutationFn: ({ groupKey, detach }: { groupKey: string; detach: boolean }) =>
      library.deleteEntry(groupKey, { detach }),
    onSuccess: () => {
      setBlockedDelete(null);
      for (const queryKey of [
        ["library-entries"],
        ["library-keys"],
        ["library-facets"],
        ["collection-papers"],
        ["paper-memberships"],
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (err: unknown, { groupKey }) => {
      const collections = blockingCollections(err);
      if (collections.length > 0) {
        setBlockedDelete({ groupKey, collections });
        return;
      }
      setBlockedDelete(null);
      const fallback = apiStatus(err) === 409 ? t("library.delete409") : t("library.deleteFailed");
      toast(apiErrorText(err, t, fallback), "error");
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
          <Link to="/settings#your-data" className="btn btn-secondary">
            <Download size={14} aria-hidden="true" /> {t("library.exportData")}
          </Link>
          <ZoteroSyncButton />
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
            onOpenDetails={(key) => setDetails({ key, unresolved: !item.resolved || !item.primary_version })}
            onRequestDelete={() => setPendingDelete(item.paper_group_key)}
            onResolved={(result) => {
              // A detailed or re-keyed entry replaces this card, focused control included.
              if (result.status === "resolved" || result.canonical_key !== result.previous_key) {
                headingRef.current?.focus();
              }
            }}
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
        paperKey={details?.key ?? null}
        onClose={() => setDetails(null)}
        resolveOnOpen={!!details?.unresolved}
        fallbackFocus={() => headingRef.current}
      />

      {pendingDelete && (
        <ConfirmModal
          title={t("library.deleteTitle")}
          message={t("library.deleteMessage")}
          confirmLabel={t("common.delete")}
          onConfirm={() => {
            deleteMutation.mutate({ groupKey: pendingDelete, detach: false });
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {blockedDelete && (
        <DeleteBlockedDialog
          collections={blockedDelete.collections}
          pending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate({ groupKey: blockedDelete.groupKey, detach: true })}
          onCancel={() => setBlockedDelete(null)}
        />
      )}
    </div>
  );
}

/** The collections a 409 `entry_in_collections` names; empty for any other error. */
function blockingCollections(err: unknown): BlockingCollection[] {
  if (apiErrorCode(err) !== "entry_in_collections") return [];
  const listed = apiErrorDetail(err)?.collections;
  if (!Array.isArray(listed)) return [];
  return listed.filter(
    (c): c is BlockingCollection =>
      typeof c === "object" &&
      c !== null &&
      typeof c.id === "string" &&
      typeof c.name === "string" &&
      typeof c.is_owner === "boolean",
  );
}

/**
 * Deleting a paper that is still in collections: name them (as links), warn
 * when some belong to other people, and offer to remove it from them too.
 */
function DeleteBlockedDialog({
  collections,
  pending,
  onConfirm,
  onCancel,
}: {
  collections: BlockingCollection[];
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const shared = collections.some((collection) => collection.is_owner === false);
  return (
    <Modal open onClose={onCancel} title={t("library.deleteBlockedTitle")}>
      <p className="confirm-message">{t("library.deleteBlockedBy", { count: collections.length })}</p>
      <ul className="library-blocking">
        {collections.map((collection) => (
          <li key={collection.id}>
            <Link to={`/collections/${collection.id}`}>{collection.name}</Link>
            {collection.is_owner === false && (
              <span className="badge badge--warning">{t("library.notOwned")}</span>
            )}
          </li>
        ))}
      </ul>
      {shared && (
        <p className="library-blocking-warning">
          <AlertTriangle size={14} aria-hidden="true" />
          {t("library.deleteNotOwnedWarning")}
        </p>
      )}
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={pending}>
          {t("library.deleteAndDetach", { count: collections.length })}
        </button>
      </div>
    </Modal>
  );
}

function LibraryEntry({
  item,
  onOpenDetails,
  onRequestDelete,
  onResolved,
}: {
  item: LibraryEntryListItem;
  onOpenDetails: (key: string) => void;
  onRequestDelete: () => void;
  onResolved: (result: LibraryResolveResult) => void;
}) {
  const { t } = useTranslation();
  const primary = item.primary_version;

  // Entries without details offer recovery (and deletion) instead of the graph.
  if (!item.resolved || !primary) {
    return (
      <UnresolvedPaperCard
        canonicalKey={item.primary_canonical_key}
        addedAt={item.created_at}
        canEdit
        onOpenDetails={() => onOpenDetails(item.primary_canonical_key)}
        onResolved={onResolved}
        actions={(describedBy) => (
          <button
            type="button"
            className="btn btn-secondary library-delete"
            onClick={onRequestDelete}
            aria-describedby={describedBy}
          >
            <Trash2 size={14} aria-hidden="true" />
            {t("common.delete")}
          </button>
        )}
      />
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
            aria-label={t("library.deleteFromLibrary")}
          >
            <Trash2 size={14} aria-hidden="true" />
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
