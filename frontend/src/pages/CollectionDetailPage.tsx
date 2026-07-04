import { useState, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { Collection, CollectionPaper, Note } from "@/types";
import ConfirmModal from "@/components/ConfirmModal";
import PaperCard from "@/components/paper/PaperCard";
import PaperDetailsDrawer from "@/components/paper/PaperDetailsDrawer";
import ReadingStateSelect from "@/components/paper/ReadingStateSelect";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import {
  Trash2,
  GitFork,
  BookMarked,
  StickyNote,
  Plus,
  ChevronDown,
  ChevronUp,
  Edit3,
  Save,
  Download,
  Upload,
  FileText,
} from "lucide-react";
import "./CollectionDetailPage.css";

export default function CollectionDetailPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [addPaperKey, setAddPaperKey] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importDois, setImportDois] = useState("");
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);

  const { data: collection, isLoading } = useQuery({
    queryKey: ["collection", id],
    queryFn: async () => {
      const { data } = await api.get<Collection>(`/collections/${id}`);
      return data;
    },
    enabled: !!id,
  });

  const { data: papers } = useQuery({
    queryKey: ["collection-papers", id],
    queryFn: async () => {
      const { data } = await api.get<CollectionPaper[]>(`/collections/${id}/papers`);
      return data;
    },
    enabled: !!id,
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
      await api.patch(`/collections/${id}`, { name: editName, description: editDesc || null });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collection", id] });
      setEditing(false);
    },
  });

  const addPaperMutation = useMutation({
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
      await queryClient.cancelQueries({ queryKey: ["collection-papers", id] });
      const previous = queryClient.getQueryData<CollectionPaper[]>(["collection-papers", id]);
      queryClient.setQueryData<CollectionPaper[]>(
        ["collection-papers", id],
        (old) => old?.filter((cp) => cp.paper_canonical_key !== paperKey) ?? [],
      );
      return { previous };
    },
    onError: (_err, _key, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["collection-papers", id], context.previous);
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

  const handleExportBibtex = async () => {
    try {
      const response = await api.get(`/collections/${id}/export/bibtex`, {
        responseType: "blob",
      });
      const blob = new Blob([response.data], { type: "application/x-bibtex" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `collection_${id}.bib`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast(t("collections.exportFailed"), "error");
    }
  };

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(i18n.language).format(new Date(value));

  if (isLoading) return <SkeletonCard count={3} />;
  if (!collection) return <p className="cd-empty">{t("collections.notFound")}</p>;

  const visibilityLabel = t(
    `collections.visibility${collection.visibility.charAt(0).toUpperCase()}${collection.visibility.slice(1)}`,
  );

  return (
    <div className="collection-detail">
      {/* Header */}
      <div className="cd-header">
        {editing ? (
          <div className="cd-edit-form">
            <input
              className="input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder={t("collections.namePlaceholder")}
            />
            <input
              className="input"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              placeholder={t("collections.descriptionPlaceholder")}
            />
            <div className="cd-edit-actions">
              <button className="btn btn-primary" onClick={() => updateMutation.mutate()}>
                <Save size={14} /> {t("collections.save")}
              </button>
              <button className="btn btn-secondary" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="cd-title-row">
              <h1>{collection.name}</h1>
              <span className="badge">{visibilityLabel}</span>
              {user && (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setEditName(collection.name);
                    setEditDesc(collection.description || "");
                    setEditing(true);
                  }}
                  title={t("collections.edit")}
                >
                  <Edit3 size={16} />
                </button>
              )}
            </div>
            {collection.description && (
              <p className="cd-description">{collection.description}</p>
            )}
            <p className="cd-meta">
              {t("collections.paperCount", { count: collection.paper_count })} ·{" "}
              {t("collections.createdOn", { date: formatDate(collection.created_at) })}
            </p>
            <div className="cd-toolbar">
              <Link to={`/graph/collection/${id}`} className="btn btn-secondary">
                <GitFork size={14} /> {t("collections.viewGraph")}
              </Link>
              <button className="btn btn-secondary" onClick={handleExportBibtex}>
                <Download size={14} /> {t("collections.exportBibtex")}
              </button>
              {user && (
                <button className="btn btn-secondary" onClick={() => setShowImport((s) => !s)}>
                  <Upload size={14} /> {t("collections.importDois")}
                </button>
              )}
            </div>
            {showImport && (
              <div className="cd-import-form card">
                <textarea
                  className="input note-textarea"
                  placeholder={t("collections.importPlaceholder")}
                  value={importDois}
                  onChange={(e) => setImportDois(e.target.value)}
                  rows={4}
                />
                <button
                  className="btn btn-primary"
                  disabled={!importDois.trim()}
                  onClick={() => {
                    const dois = importDois.split("\n").map((d) => d.trim()).filter(Boolean);
                    if (dois.length > 0) importDoisMutation.mutate(dois);
                  }}
                >
                  {t("collections.importButton", {
                    count: importDois.split("\n").filter((d) => d.trim()).length,
                  })}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Add paper */}
      {user && (
      <div className="cd-add-paper">
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
      </div>
      )}

      {/* Paper list */}
      <div className="cd-papers">
        <h2>{t("collections.papersHeading")}</h2>
        {papers && papers.length === 0 && (
          <EmptyState
            icon={FileText}
            title={t("collections.emptyPapersTitle")}
            description={t("collections.emptyPapersDescription")}
          />
        )}
        {papers &&
          papers.map((cp) => (
            <CollectionPaperItem
              key={cp.paper_canonical_key}
              item={cp}
              onRemove={() => setPendingDeleteKey(cp.paper_canonical_key)}
              onOpenDetails={setDetailsKey}
            />
          ))}
      </div>

      {/* Delete confirmation modal */}
      {pendingDeleteKey && (
        <ConfirmModal
          title={t("collections.removePaperTitle")}
          message={t("collections.removePaperMessage", {
            name: paperDisplayName(papers, pendingDeleteKey),
          })}
          confirmLabel={t("collections.remove")}
          onConfirm={() => {
            removePaperMutation.mutate(pendingDeleteKey);
            setPendingDeleteKey(null);
          }}
          onCancel={() => setPendingDeleteKey(null)}
        />
      )}

      {/* Collection notes section */}
      {user && (
      <div className="cd-notes-section">
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
              className="note-form"
            >
              <textarea
                className="input note-textarea"
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
              <div key={note.id} className="note-item card">
                <p>{note.content}</p>
                <div className="note-meta">
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
      </div>
      )}

      <PaperDetailsDrawer paperKey={detailsKey} onClose={() => setDetailsKey(null)} />
    </div>
  );
}

function paperDisplayName(papers: CollectionPaper[] | undefined, key: string): string {
  const match = papers?.find((cp) => cp.paper_canonical_key === key);
  const name = match?.paper?.title ?? key;
  return name.length > 60 ? `${name.slice(0, 60)}…` : name;
}

function CollectionPaperItem({
  item,
  onRemove,
  onOpenDetails,
}: {
  item: CollectionPaper;
  onRemove: () => void;
  onOpenDetails: (key: string) => void;
}) {
  const { t, i18n } = useTranslation();
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
        <div className="cp-state">
          <ReadingStateSelect paperKey={item.paper_canonical_key} />
        </div>
      )}
      {user && item.paper_group_key && (
        <Link
          to={`/library?focus=${encodeURIComponent(item.paper_group_key)}`}
          className="btn-ghost"
          title={t("collections.openInLibrary")}
        >
          <BookMarked size={14} />
        </Link>
      )}
      <Link
        to={`/graph/${encodeURIComponent(item.paper_canonical_key)}`}
        className="btn-ghost"
        title={t("paper.exploreGraph")}
      >
        <GitFork size={14} />
      </Link>
      {user && (
        <button className="btn-ghost" onClick={onRemove} title={t("collections.removeFromCollection")}>
          <Trash2 size={14} />
        </button>
      )}
      <span className="cp-added">
        {t("collections.addedOn", {
          date: new Intl.DateTimeFormat(i18n.language).format(new Date(item.added_at)),
        })}
      </span>
    </>
  );

  if (!item.paper) {
    // No cached metadata yet — degrade to the canonical key.
    return (
      <div className="cp-item card">
        <div className="cp-header">
          <button
            type="button"
            className="cp-key paper-title-btn"
            title={item.paper_canonical_key}
            onClick={() => onOpenDetails(item.paper_canonical_key)}
          >
            {item.paper_canonical_key.length > 60
              ? item.paper_canonical_key.slice(0, 60) + "…"
              : item.paper_canonical_key}
          </button>
        </div>
        <div className="paper-actions">{actions}</div>
      </div>
    );
  }

  return (
    <PaperCard
      paper={item.paper}
      onOpenDetails={() => onOpenDetails(item.paper_canonical_key)}
      showAbstract={false}
      showTopics={false}
      headerBadges={
        tags && tags.length > 0 ? (
          <>
            {tags.slice(0, 4).map(({ tag }) => (
              <span key={tag} className="paper-tag">
                {tag}
              </span>
            ))}
          </>
        ) : undefined
      }
      actions={actions}
    />
  );
}
