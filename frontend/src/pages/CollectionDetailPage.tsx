import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import api, { library, papers as paperApi } from "@/lib/api";
import { apiErrorText, apiStatus } from "@/lib/apiError";
import { useAuth } from "@/contexts/AuthContext";
import type { Collection, CollectionPaper, LibraryResolveResult, Note } from "@/types";
import ConfirmModal from "@/components/ConfirmModal";
import PaperCard from "@/components/paper/PaperCard";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import ReadingStateSelect from "@/components/paper/ReadingStateSelect";
import UnresolvedPaperCard from "@/components/paper/UnresolvedPaperCard";
import AddPaperForm from "@/components/collections/AddPaperForm";
import ImportIdentifiersModal from "@/components/collections/ImportIdentifiersModal";
import ZoteroSyncButton from "@/components/zotero/ZoteroSyncButton";
import RowSkeletons from "@/components/paper/RowSkeletons";
import EmptyState from "@/components/ui/EmptyState";
import SectionHeading from "@/components/ui/SectionHeading";
import { useTopBarTitle } from "@/components/shell/ShellContext";
import { useToast } from "@/components/ui/Toast";
import {
  Trash2,
  GitFork,
  StickyNote,
  ChevronDown,
  ChevronUp,
  Edit3,
  Share2,
  Upload,
  FileText,
  FolderOpen,
} from "lucide-react";
import "./CollectionDetailPage.css";
import CollectionSharing from "@/components/collections/CollectionSharing";
import { useCollectionAccess, collectionRead } from "@/lib/collection-access";

/** A row with no cached details: a pending DOI or a legacy key. */
function isUnresolved(item: CollectionPaper): boolean {
  return !item.paper || item.resolved === false;
}

export default function CollectionDetailPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { user, isLoading: authLoading } = useAuth();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const access = useCollectionAccess(id);
  const [showSharing, setShowSharing] = useState(false);
  const collectionKey = ["collection", id, access.scope];
  const papersKey = ["collection-papers", id, access.scope];
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editRevision, setEditRevision] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
  const [details, setDetails] = useState<{ key: string; unresolved: boolean } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const { data: collection, isLoading, isError: collectionError } = useQuery({
    queryKey: collectionKey,
    queryFn: () => collectionRead(async () => (await api.get<Collection>(`/collections/${id}`, { headers: access.headers })).data),
    gcTime: 0, staleTime: 0, refetchOnWindowFocus: "always", retry: false,
    enabled: !!id && !authLoading,
  });

  const { data: papers } = useQuery({
    queryKey: papersKey,
    queryFn: () => collectionRead(async () => {
      const requestedAt = Date.now();
      const { data } = await api.get<CollectionPaper[]>(`/collections/${id}/papers`, { headers: access.headers });
      seedPaperAnnotations(queryClient, data, requestedAt);
      return data;
    }),
    gcTime: 0, staleTime: 0, refetchOnWindowFocus: "always", retry: false,
    enabled: !!collection,
  });

  // The breadcrumb names the open collection.
  useTopBarTitle(collection?.name);

  useEffect(() => {
    if (collection === null) {
      void queryClient.cancelQueries({ queryKey: ["collection-papers", id] });
      queryClient.setQueriesData({ queryKey: ["collection-papers", id] }, null);
      setDetails(null);
    }
  }, [collection, id, queryClient]);

  // Library pins let a signed-in reader re-resolve rows they also saved.
  const hasUnresolved = !!papers?.some(isUnresolved);
  const { data: libraryKeys } = useQuery({
    queryKey: ["library-keys"],
    queryFn: () => library.listKeys(),
    enabled: !!user && hasUnresolved,
    staleTime: 30_000,
  });

  const { data: notes } = useQuery({
    queryKey: ["notes", "collection", id],
    queryFn: async () => {
      const { data } = await api.get<Note[]>("/notes", {
        params: { target_type: "collection", target_key: id },
      });
      return data;
    },
    enabled: !!id && showNotes,
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      await api.patch(`/collections/${id}`, { name: editName, description: editDesc || null, revision: editRevision });
    },
    onError: () => { toast(t("sharing.updateConflict"), "error"); void queryClient.invalidateQueries({ queryKey: ["collection", id] }); },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collection", id] });
      setEditing(false);
    },
  });

  // A 403/404 on a write: access changed while the page was open.
  const refreshAccessAfterError = () => {
    toast(t("sharing.unavailable"), "error");
    void queryClient.invalidateQueries({ queryKey: ["collection", id] });
  };

  const removePaperMutation = useMutation({
    mutationFn: async (paperKey: string) => {
      await api.delete(`/collections/${id}/papers/${encodeURIComponent(paperKey)}`);
    },
    onMutate: async (paperKey: string) => {
      await queryClient.cancelQueries({ queryKey: papersKey });
      const previous = queryClient.getQueryData<CollectionPaper[]>(papersKey);
      queryClient.setQueryData<CollectionPaper[]>(
        papersKey,
        (old) => old?.filter((cp) => cp.paper_canonical_key !== paperKey) ?? [],
      );
      return { previous };
    },
    onError: (err, _key, context) => {
      const status = apiStatus(err);
      if (status === 403 || status === 404) refreshAccessAfterError();
      else toast(apiErrorText(err, t, t("collections.removeFailed")), "error");
      if (context?.previous) {
        queryClient.setQueryData(papersKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["collection-papers", id] });
      void queryClient.invalidateQueries({ queryKey: ["collection", id] });
      void queryClient.invalidateQueries({ queryKey: ["paper-memberships"] });
    },
  });

  const createNoteMutation = useMutation({
    mutationFn: async () => {
      await api.post("/notes", { target_type: "collection", target_key: id, content: newNote });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes", "collection", id] });
      setNewNote("");
    },
  });

  const deleteNoteMutation = useMutation({
    mutationFn: async (noteId: string) => {
      await api.delete(`/notes/${noteId}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes", "collection", id] });
    },
  });

  const formatDate = (value: string) =>
    // The Collections list's style ("Oct 3, 2026"), not a locale-ambiguous 10/3/2026.
    new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, { dateStyle: "medium" }).format(
      new Date(value),
    );

  // Rendered at the same place in both branches below: a mid-import 403/404
  // that makes the collection unavailable keeps the per-line report open until Done.
  const importModal = showImport && (
    <ImportIdentifiersModal
      collectionId={id!}
      onClose={() => setShowImport(false)}
      onAccessError={refreshAccessAfterError}
    />
  );

  // A resolve that replaces an unresolved row's card takes its focused control with it.
  const onRowResolved = (result: LibraryResolveResult) => {
    if (result.status === "resolved" || result.canonical_key !== result.previous_key) {
      headingRef.current?.focus();
    }
  };

  if (isLoading || authLoading) {
    return (
      <div className="collection-detail">
        <RowSkeletons count={3} />
      </div>
    );
  }
  if (!collection || collectionError) {
    return (
      <>
        <EmptyState
          icon={FolderOpen}
          title={t("sharing.unavailable")}
          action={
            !user ? (
              <Link to="/login" state={{ returnTo: access.returnTo }} className="btn btn-primary">
                {t("sharing.login")}
              </Link>
            ) : undefined
          }
        />
        {importModal}
      </>
    );
  }

  const detailsRow = details ? papers?.find((cp) => cp.paper_canonical_key === details.key) : undefined;
  // Re-resolving on open writes, so only editors and users with a Library pin do it.
  const resolveOnOpen =
    !!details?.unresolved &&
    !!user &&
    (collection.can_edit || (!!detailsRow?.paper_group_key && !!libraryKeys?.includes(detailsRow.paper_group_key)));

  return (
    <>
      <div className="collection-detail">
        {/* Header */}
        <header className="cd-header">
          {editing && collection.can_edit ? (
            <form
              className="cd-edit-form"
              onSubmit={(e) => {
                e.preventDefault();
                updateMutation.mutate();
              }}
            >
              <label className="cd-field">
                {t("collections.namePlaceholder")}
                <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} required />
              </label>
              <label className="cd-field">
                {t("collections.descriptionPlaceholder")}
                <input className="input" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
              </label>
              <div className="cd-edit-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>
                  {t("common.cancel")}
                </button>
                <button type="submit" className="btn btn-primary">
                  {t("collections.save")}
                </button>
              </div>
            </form>
          ) : (
            <div className="page-header cd-header-main">
              <div className="page-header-text">
                <p className="page-header-eyebrow">
                  <span>{t("collections.eyebrow")}</span>
                  <span aria-hidden="true"> · </span>
                  <span>{t(collection.is_owner ? "sharing.owner" : collection.can_edit ? "sharing.editor" : "sharing.reader")}</span>
                </p>
                <div className="cd-title-row">
                  <h1 ref={headingRef} tabIndex={-1} className="page-header-title">
                    {collection.name}
                  </h1>
                  {collection.can_edit && (
                    <button
                      type="button"
                      className="btn-quiet btn-quiet--muted cd-edit"
                      onClick={() => {
                        setEditRevision(collection.revision);
                        setEditName(collection.name);
                        setEditDesc(collection.description || "");
                        setEditing(true);
                      }}
                      title={t("collections.edit")}
                      aria-label={t("collections.edit")}
                    >
                      <Edit3 size={15} aria-hidden="true" />
                    </button>
                  )}
                </div>
                {collection.description && <p className="page-header-description cd-description">{collection.description}</p>}
                <p className="cd-meta tabular">
                  {t("collections.paperCount", { count: collection.paper_count })} ·{" "}
                  {t("collections.createdOn", { date: formatDate(collection.created_at) })}
                </p>
              </div>
              <div className="page-header-actions">
                {collection.can_manage_access && (
                  <button type="button" className="btn btn-primary" onClick={() => setShowSharing(true)}>
                    <Share2 size={14} aria-hidden="true" /> {t("sharing.title")}
                  </button>
                )}
                {!user && <Link className="btn btn-secondary" to="/login" state={{ returnTo: access.returnTo }}>{t("sharing.login")}</Link>}
                <Link to={`/graph/collection/${id}${access.fragment}`} className="btn btn-secondary">
                  <GitFork size={14} aria-hidden="true" /> {t("collections.viewGraph")}
                </Link>
                {user && collection.can_edit && (
                  <button type="button" className="btn btn-secondary" onClick={() => setShowImport(true)}>
                    <Upload size={14} aria-hidden="true" /> {t("collections.importDois")}
                  </button>
                )}
                <ZoteroSyncButton collectionId={id} headers={access.headers} />
              </div>
            </div>
          )}
        </header>

        {collection.can_edit && <AddPaperForm collectionId={id!} onAccessError={refreshAccessAfterError} />}

        {/* Paper list */}
        <section className="cd-papers" aria-labelledby="cd-papers-title">
          <SectionHeading
            id="cd-papers-title"
            title={t("collections.papersHeading")}
            action={
              <span className="cd-papers-count tabular">
                {t("collections.paperCount", { count: papers?.length ?? collection.paper_count })}
              </span>
            }
          />
          {papers && papers.length === 0 && (
            <EmptyState
              icon={FileText}
              title={t("collections.emptyPapersTitle")}
              description={t(collection.can_edit ? "collections.emptyPapersDescription" : "collections.emptyPapersReadOnly")}
            />
          )}
          {papers && papers.length > 0 && (
            <ul className="list-rows cd-paper-list">
              {papers.map((cp) => (
                <CollectionPaperItem
                  key={cp.paper_canonical_key}
                  item={cp}
                  canEdit={collection.can_edit}
                  onRemove={() => setPendingDeleteKey(cp.paper_canonical_key)}
                  onOpenDetails={(key) => setDetails({ key, unresolved: isUnresolved(cp) })}
                  onResolved={onRowResolved}
                  onAccessError={refreshAccessAfterError}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Collection notes: a disclosure under a section heading. */}
        {user && (
          <section className="cd-notes-section">
            <h2 className="section-heading cd-notes-heading">
              <button
                type="button"
                className="cd-notes-toggle"
                onClick={() => setShowNotes((s) => !s)}
                aria-expanded={showNotes}
                aria-controls="cd-notes"
              >
                <StickyNote size={16} aria-hidden="true" />
                <span className="section-heading-title">{t("collections.notes")}</span>
                {showNotes ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
              </button>
            </h2>

            {showNotes && (
              <div className="cd-notes" id="cd-notes">
                <form
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (newNote.trim()) createNoteMutation.mutate();
                  }}
                  className="cd-note-form"
                >
                  <textarea
                    className="input"
                    placeholder={t("collections.notePlaceholder")}
                    aria-label={t("collections.notes")}
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    rows={3}
                  />
                  <button type="submit" className="btn btn-primary" disabled={!newNote.trim()}>
                    {t("paper.addNote")}
                  </button>
                </form>

                {notes && notes.length > 0 && (
                  <ul className="list-rows cd-note-list">
                    {notes.map((note) => (
                      <li key={note.id} className="list-row cd-note">
                        <p>{note.content}</p>
                        <div className="cd-note-meta">
                          <span>{formatDate(note.updated_at)}</span>
                          <button
                            type="button"
                            className="btn-quiet btn-quiet--muted cd-note-delete"
                            onClick={() => deleteNoteMutation.mutate(note.id)}
                            title={t("common.delete")}
                            aria-label={t("common.delete")}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}

        {pendingDeleteKey && collection.can_edit && (
          <ConfirmModal
            title={t("collections.removePaperTitle")}
            message={t("collections.removePaperMessage", {
              name: paperDisplayName(papers ?? undefined, pendingDeleteKey, t("collections.thisPaper")),
            })}
            confirmLabel={t("collections.remove")}
            onConfirm={() => {
              removePaperMutation.mutate(pendingDeleteKey);
              setPendingDeleteKey(null);
            }}
            onCancel={() => setPendingDeleteKey(null)}
          />
        )}

        {showSharing && collection.can_manage_access && <CollectionSharing collectionId={id!} onClose={() => setShowSharing(false)} />}
        <PaperDetailsPanel
          paperKey={details?.key ?? null}
          onClose={() => setDetails(null)}
          resolveOnOpen={resolveOnOpen}
          fallbackFocus={() => headingRef.current}
        />
      </div>
      {importModal}
    </>
  );
}

/**
 * The list rows carry the caller's own states and tags: seed the per-paper
 * queries the rows, ReadingStateSelect and TagEditor read, so a long
 * collection costs one request instead of two per row. An entry written after
 * the list request started (a saved state, a tag refetch) is newer than the
 * row and is kept.
 */
function seedPaperAnnotations(queryClient: QueryClient, rows: CollectionPaper[], requestedAt: number) {
  const seed = (queryKey: string[], value: unknown) => {
    if ((queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0) > requestedAt) return;
    queryClient.setQueryData(queryKey, value);
  };
  for (const row of rows) {
    if (row.my_states) seed(["paper-states", row.paper_canonical_key], row.my_states);
    if (row.my_tags) seed(["paper-tags", row.paper_canonical_key], row.my_tags);
  }
}

/** Never surface a raw canonical key — degrade to a generic label. */
function paperDisplayName(
  papers: CollectionPaper[] | undefined,
  key: string,
  fallback: string,
): string {
  const match = papers?.find((cp) => cp.paper_canonical_key === key);
  const name = match?.paper?.title ?? fallback;
  return name.length > 60 ? `${name.slice(0, 60)}…` : name;
}

function CollectionPaperItem({
  item,
  canEdit,
  onRemove,
  onOpenDetails,
  onResolved,
  onAccessError,
}: {
  item: CollectionPaper;
  canEdit: boolean;
  onRemove: () => void;
  onOpenDetails: (key: string) => void;
  onResolved: (result: LibraryResolveResult) => void;
  onAccessError: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const unresolved = isUnresolved(item);

  // Seeded and kept fresh by the list response; refetched alone after a tag edit.
  const { data: tags } = useQuery({
    queryKey: ["paper-tags", item.paper_canonical_key],
    queryFn: () => paperApi.getTags(item.paper_canonical_key),
    enabled: !!user && !unresolved,
    staleTime: Infinity,
  });

  if (unresolved || !item.paper) {
    // No details to explore yet: offer recovery instead of the graph and reading state.
    return (
      <li className="list-row cd-row">
        <UnresolvedPaperCard
          canonicalKey={item.paper_canonical_key}
          addedAt={item.added_at}
          canEdit={canEdit}
          onOpenDetails={() => onOpenDetails(item.paper_canonical_key)}
          onResolved={onResolved}
          onResolveError={(err) => {
            const status = apiStatus(err);
            if (status !== 403 && status !== 404) return false;
            onAccessError();
            return true;
          }}
          actions={(describedBy) => (
            <button
              type="button"
              className="btn-quiet btn-quiet--muted cd-remove"
              onClick={onRemove}
              aria-describedby={describedBy}
              title={t("collections.removeFromCollection")}
            >
              <Trash2 size={14} aria-hidden="true" />
              {t("collections.remove")}
            </button>
          )}
        />
      </li>
    );
  }

  const actions = (
    <>
      {user && (
        <div className="cd-state">
          <ReadingStateSelect paperKey={item.paper_canonical_key} fromList />
        </div>
      )}
      <Link to={`/graph/${encodeURIComponent(item.paper_canonical_key)}`} className="btn-quiet">
        <GitFork size={14} aria-hidden="true" />
        {t("paper.exploreGraph")}
      </Link>
      {canEdit && (
        <button
          type="button"
          className="btn-quiet btn-quiet--muted cd-remove"
          onClick={onRemove}
          title={t("collections.removeFromCollection")}
          aria-label={t("collections.removeFromCollection")}
        >
          <Trash2 size={14} aria-hidden="true" />
          {t("collections.remove")}
        </button>
      )}
    </>
  );

  return (
    <li className="list-row cd-row">
      <PaperCard
        paper={item.paper}
        onOpenDetails={() => onOpenDetails(item.paper_canonical_key)}
        showAbstract={false}
        variant="row"
        actions={actions}
      >
        {tags && tags.length > 0 && (
          <ul className="cd-paper-tags" aria-label={t("paper.tags")}>
            {tags.slice(0, 4).map(({ tag }) => (
              <li key={tag} className="paper-tag">
                {tag}
              </li>
            ))}
          </ul>
        )}
      </PaperCard>
    </li>
  );
}
