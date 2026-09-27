import { useEffect, useState, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import api, { zotero } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { Collection, CollectionPaper, Note, ZoteroSyncReport } from "@/types";
import ConfirmModal from "@/components/ConfirmModal";
import Modal from "@/components/ui/Modal";
import PaperCard from "@/components/paper/PaperCard";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import ReadingStateSelect from "@/components/paper/ReadingStateSelect";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import {
  Trash2,
  GitFork,
  BookUp,
  StickyNote,
  Plus,
  ChevronDown,
  ChevronUp,
  Edit3,
  Upload,
  FileText,
} from "lucide-react";
import "./CollectionDetailPage.css";
import CollectionSharing from "@/components/collections/CollectionSharing";
import { useCollectionAccess, collectionRead } from "@/lib/collection-access";

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
  const [addPaperKey, setAddPaperKey] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importDois, setImportDois] = useState("");
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);

  const { data: collection, isLoading, isError: collectionError } = useQuery({
    queryKey: collectionKey,
    queryFn: () => collectionRead(async () => (await api.get<Collection>(`/collections/${id}`, { headers: access.headers })).data),
    gcTime: 0, staleTime: 0, refetchOnWindowFocus: "always", retry: false,
    enabled: !!id && !authLoading,
  });

  const { data: papers } = useQuery({
    queryKey: papersKey,
    queryFn: () => collectionRead(async () => (await api.get<CollectionPaper[]>(`/collections/${id}/papers`, { headers: access.headers })).data),
    gcTime: 0, staleTime: 0, refetchOnWindowFocus: "always", retry: false,
    enabled: !!collection,
  });

  useEffect(() => {
    if (collection === null) {
      void queryClient.cancelQueries({ queryKey: ["collection-papers", id] });
      queryClient.setQueriesData({ queryKey: ["collection-papers", id] }, null);
      setDetailsKey(null);
    }
  }, [collection, id, queryClient]);

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

  const refreshAccessAfterError = () => {
    toast(t("sharing.error"), "error");
    void queryClient.invalidateQueries({ queryKey: ["collection", id] });
  };

  const addPaperMutation = useMutation({
    onError: refreshAccessAfterError,
    mutationFn: async (paperKey: string) => {
      await api.post(`/collections/${id}/papers`, { paper_canonical_key: paperKey });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collection-papers", id] });
      void queryClient.invalidateQueries({ queryKey: ["collection", id] });
      setAddPaperKey("");
    },
  });

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
    onError: (_err, _key, context) => {
      refreshAccessAfterError();
      if (context?.previous) {
        queryClient.setQueryData(papersKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["collection-papers", id] });
      void queryClient.invalidateQueries({ queryKey: ["collection", id] });
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

  const importDoisMutation = useMutation({
    onError: refreshAccessAfterError,
    mutationFn: async (dois: string[]) => {
      const { data } = await api.post(`/collections/${id}/import/dois`, { dois });
      return data as { added: number; skipped: number; total: number };
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["collection-papers", id] });
      void queryClient.invalidateQueries({ queryKey: ["collection", id] });
      setImportDois("");
      setShowImport(false);
      toast(t("collections.imported", { added: data.added, skipped: data.skipped }), "success");
    },
  });

  const { data: zoteroStatus } = useQuery({
    queryKey: ["zotero-status"],
    queryFn: () => zotero.getStatus(),
    enabled: !!user,
  });

  const zoteroSyncMutation = useMutation({
    mutationFn: () => zotero.syncCollection(id!, access.headers),
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

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(i18n.language).format(new Date(value));

  if (isLoading || authLoading) return <SkeletonCard count={3} />;
  if (!collection || collectionError) return <div className="cd-notfound"><p>{t("sharing.unavailable")}</p>{!user && <Link to="/login" state={{ returnTo: access.returnTo }} className="btn btn-primary">{t("sharing.login")}</Link>}</div>;

  const importCount = importDois.split("\n").filter((d) => d.trim()).length;

  return (
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
            <input
              className="input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder={t("collections.namePlaceholder")}
              required
            />
            <input
              className="input"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              placeholder={t("collections.descriptionPlaceholder")}
            />
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
          <>
            <div className="cd-title-row">
              <h1>{collection.name}</h1>
              <span className="badge badge--neutral">{t(collection.is_owner ? "sharing.owner" : collection.can_edit ? "sharing.editor" : "sharing.reader")}</span>
              {collection.can_edit && (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setEditRevision(collection.revision);
                    setEditName(collection.name);
                    setEditDesc(collection.description || "");
                    setEditing(true);
                  }}
                  title={t("collections.edit")}
                >
                  <Edit3 size={15} />
                </button>
              )}
            </div>
            {collection.description && <p className="cd-description">{collection.description}</p>}
            <p className="cd-meta">
              {t("collections.paperCount", { count: collection.paper_count })} ·{" "}
              {t("collections.createdOn", { date: formatDate(collection.created_at) })}
            </p>
            <div className="cd-toolbar">
              {collection.can_manage_access && <button className="btn btn-primary" onClick={() => setShowSharing(true)}>{t("sharing.title")}</button>}
              {!user && <Link className="btn btn-secondary" to="/login" state={{ returnTo: access.returnTo }}>{t("sharing.login")}</Link>}
              <Link to={`/graph/collection/${id}${access.fragment}`} className="btn btn-secondary">
                <GitFork size={14} /> {t("collections.viewGraph")}
              </Link>
              {user && (
                <>
                  <button
                    className="btn btn-secondary"
                    onClick={() => zoteroSyncMutation.mutate()}
                    disabled={!zoteroStatus?.connected || zoteroSyncMutation.isPending}
                    title={zoteroStatus?.connected ? t("zotero.sync") : t("zotero.notConfigured")}
                  >
                    <BookUp size={14} /> {t("zotero.sync")}
                  </button>
                  {collection.can_edit && <button className="btn btn-secondary" onClick={() => setShowImport(true)}>
                    <Upload size={14} /> {t("collections.importDois")}
                  </button>}
                </>
              )}
            </div>
          </>
        )}
      </header>

      {/* Add paper */}
      {collection.can_edit && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (addPaperKey.trim()) addPaperMutation.mutate(addPaperKey.trim());
          }}
          className="cd-add-form"
        >
          <input
            className="input"
            placeholder={t("collections.addPaperPlaceholder")}
            value={addPaperKey}
            onChange={(e) => setAddPaperKey(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={!addPaperKey.trim()}>
            <Plus size={14} /> {t("collections.addPaper")}
          </button>
        </form>
      )}

      {/* Paper list */}
      <section className="cd-papers">
        {papers && papers.length === 0 && (
          <EmptyState
            icon={FileText}
            title={t("collections.emptyPapersTitle")}
            description={t("collections.emptyPapersDescription")}
          />
        )}
        {papers?.map((cp) => (
          <CollectionPaperItem
            key={cp.paper_canonical_key}
            item={cp}
            canEdit={collection.can_edit}
            onRemove={() => setPendingDeleteKey(cp.paper_canonical_key)}
            onOpenDetails={setDetailsKey}
          />
        ))}
      </section>

      {/* Collection notes */}
      {user && (
        <section className="cd-notes-section">
          <button className="btn btn-secondary" onClick={() => setShowNotes((s) => !s)}>
            <StickyNote size={14} />
            {t("collections.notes")}
            {showNotes ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {showNotes && (
            <div className="cd-notes">
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
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  rows={3}
                />
                <button type="submit" className="btn btn-primary" disabled={!newNote.trim()}>
                  {t("paper.addNote")}
                </button>
              </form>

              {notes?.map((note) => (
                <div key={note.id} className="card cd-note">
                  <p>{note.content}</p>
                  <div className="cd-note-meta">
                    <span>{formatDate(note.updated_at)}</span>
                    <button
                      className="btn-ghost"
                      onClick={() => deleteNoteMutation.mutate(note.id)}
                      title={t("common.delete")}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Import modal */}
      <Modal
        open={showImport && collection.can_edit}
        onClose={() => setShowImport(false)}
        title={t("collections.importDois")}
      >
        <textarea
          className="input"
          placeholder={t("collections.importPlaceholder")}
          value={importDois}
          onChange={(e) => setImportDois(e.target.value)}
          rows={5}
          autoFocus
        />
        <div className="confirm-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setShowImport(false)}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn-primary"
            disabled={importCount === 0 || importDoisMutation.isPending}
            onClick={() => {
              const dois = importDois.split("\n").map((d) => d.trim()).filter(Boolean);
              if (dois.length > 0) importDoisMutation.mutate(dois);
            }}
          >
            {t("collections.importButton", { count: importCount })}
          </button>
        </div>
      </Modal>

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
      <PaperDetailsPanel paperKey={detailsKey} onClose={() => setDetailsKey(null)} />
    </div>
  );
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
}: {
  item: CollectionPaper;
  canEdit: boolean;
  onRemove: () => void;
  onOpenDetails: (key: string) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();

  const { data: tags } = useQuery({
    queryKey: ["paper-tags", item.paper_canonical_key],
    queryFn: async () => {
      const { data } = await api.get(
        `/papers/${encodeURIComponent(item.paper_canonical_key)}/tags`,
      );
      return data as { tag: string }[];
    },
    enabled: !!user,
  });

  const actions = (
    <>
      {user && (
        <div className="cd-state">
          <ReadingStateSelect paperKey={item.paper_canonical_key} />
        </div>
      )}
      <Link
        to={`/graph/${encodeURIComponent(item.paper_canonical_key)}`}
        className="btn btn-secondary"
      >
        <GitFork size={14} />
        {t("paper.exploreGraph")}
      </Link>
      {canEdit && (
        <button
          className="btn-ghost cd-remove"
          onClick={onRemove}
          title={t("collections.removeFromCollection")}
        >
          <Trash2 size={14} />
        </button>
      )}
    </>
  );

  if (!item.paper) {
    // No cached metadata yet — a minimal row that still opens the panel.
    return (
      <div className="card cd-paper-fallback">
        <button
          type="button"
          className="paper-title paper-title-btn"
          onClick={() => onOpenDetails(item.paper_canonical_key)}
        >
          {t("paper.detailsTitle")}
        </button>
        <div className="paper-actions">{actions}</div>
      </div>
    );
  }

  return (
    <PaperCard
      paper={item.paper}
      onOpenDetails={() => onOpenDetails(item.paper_canonical_key)}
      showAbstract={false}
      actions={actions}
    >
      {tags && tags.length > 0 && (
        <div className="cd-paper-tags">
          {tags.slice(0, 4).map(({ tag }) => (
            <span key={tag} className="paper-tag">
              {tag}
            </span>
          ))}
        </div>
      )}
    </PaperCard>
  );
}
