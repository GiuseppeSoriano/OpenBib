import { useState, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import type { Collection, CollectionPaper, Note } from "@/types";
import ConfirmModal from "@/components/ConfirmModal";
import {
  Trash2,
  GitFork,
  StickyNote,
  Plus,
  X,
  ChevronDown,
  ChevronUp,
  Edit3,
  Save,
  Download,
  Upload,
} from "lucide-react";
import "./CollectionDetailPage.css";

const READING_STATES = [
  "unseen", "seen", "saved", "to_read", "reading", "read", "important", "ignored", "excluded",
] as const;

export default function CollectionDetailPage() {
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
      alert(`Imported: ${data.added} added, ${data.skipped} skipped`);
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
      alert("Export failed");
    }
  };

  if (isLoading) return <p className="loading-text">Loading…</p>;
  if (!collection) return <p className="loading-text">Collection not found</p>;

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
              placeholder="Collection name"
            />
            <input
              className="input"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              placeholder="Description"
            />
            <div className="cd-edit-actions">
              <button className="btn btn-primary" onClick={() => updateMutation.mutate()}>
                <Save size={14} /> Save
              </button>
              <button className="btn btn-secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="cd-title-row">
              <h1>{collection.name}</h1>
              <span className="badge">{collection.visibility}</span>
              <button
                className="btn-ghost"
                onClick={() => {
                  setEditName(collection.name);
                  setEditDesc(collection.description || "");
                  setEditing(true);
                }}
                title="Edit collection"
              >
                <Edit3 size={16} />
              </button>
            </div>
            {collection.description && (
              <p className="cd-description">{collection.description}</p>
            )}
            <p className="cd-meta">
              {collection.paper_count} paper{collection.paper_count !== 1 ? "s" : ""} ·
              Created {new Date(collection.created_at).toLocaleDateString()}
            </p>
            <div className="cd-toolbar">
              <button className="btn btn-secondary" onClick={handleExportBibtex}>
                <Download size={14} /> Export BibTeX
              </button>
              <button className="btn btn-secondary" onClick={() => setShowImport((s) => !s)}>
                <Upload size={14} /> Import DOIs
              </button>
            </div>
            {showImport && (
              <div className="cd-import-form card">
                <textarea
                  className="input note-textarea"
                  placeholder="Paste DOIs, one per line…"
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
                  Import {importDois.split("\n").filter((d) => d.trim()).length} DOIs
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Add paper */}
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
            placeholder="Paste a DOI or canonical key to add…"
            value={addPaperKey}
            onChange={(e) => setAddPaperKey(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={!addPaperKey.trim()}>
            <Plus size={14} /> Add paper
          </button>
        </form>
      </div>

      {/* Paper list */}
      <div className="cd-papers">
        <h2>Papers</h2>
        {papers && papers.length === 0 && (
          <p className="cd-empty">
            No papers yet. Search for papers and add them, or paste a DOI/canonical key above.
          </p>
        )}
        {papers && papers.map((cp) => (
          <CollectionPaperItem
            key={cp.paper_canonical_key}
            paper={cp}
            collectionId={id!}
            onRemove={() => setPendingDeleteKey(cp.paper_canonical_key)}
          />
        ))}
      </div>

      {/* Delete confirmation modal */}
      {pendingDeleteKey && (
        <ConfirmModal
          title="Remove paper"
          message={`Are you sure you want to remove "${pendingDeleteKey.length > 60 ? pendingDeleteKey.slice(0, 60) + "…" : pendingDeleteKey}" from this collection?`}
          confirmLabel="Remove"
          onConfirm={() => {
            removePaperMutation.mutate(pendingDeleteKey);
            setPendingDeleteKey(null);
          }}
          onCancel={() => setPendingDeleteKey(null)}
        />
      )}

      {/* Notes section */}
      <div className="cd-notes-section">
        <button
          className="btn btn-secondary"
          onClick={() => setShowNotes((s) => !s)}
        >
          <StickyNote size={14} />
          Notes
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
                placeholder="Write a note about this collection…"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                rows={3}
              />
              <button type="submit" className="btn btn-primary" disabled={!newNote.trim()}>
                Add note
              </button>
            </form>

            {notes?.map((note) => (
              <div key={note.id} className="note-item card">
                <p>{note.content}</p>
                <div className="note-meta">
                  <span>{new Date(note.updated_at).toLocaleString()}</span>
                  <button
                    className="btn-ghost"
                    onClick={() => deleteNoteMutation.mutate(note.id)}
                    title="Delete note"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CollectionPaperItem({
  paper,
  collectionId,
  onRemove,
}: {
  paper: CollectionPaper;
  collectionId: string;
  onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const [showNotes, setShowNotes] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [newNote, setNewNote] = useState("");

  const { data: states } = useQuery({
    queryKey: ["paper-state", paper.paper_canonical_key],
    queryFn: async () => {
      const { data } = await api.get(`/papers/${encodeURIComponent(paper.paper_canonical_key)}/states`);
      return data as { state: string; collection_id: string | null }[];
    },
  });

  const { data: tags } = useQuery({
    queryKey: ["paper-tags", paper.paper_canonical_key],
    queryFn: async () => {
      const { data } = await api.get(`/papers/${encodeURIComponent(paper.paper_canonical_key)}/tags`);
      return data as { tag: string }[];
    },
  });

  const { data: notes } = useQuery({
    queryKey: ["notes", "paper", paper.paper_canonical_key],
    queryFn: async () => {
      const { data } = await api.get<Note[]>("/notes", {
        params: { target_type: "paper", target_key: paper.paper_canonical_key },
      });
      return data;
    },
    enabled: showNotes,
  });

  const setStateMutation = useMutation({
    mutationFn: async (state: string) => {
      await api.put(`/papers/${encodeURIComponent(paper.paper_canonical_key)}/state`, {
        state,
        collection_id: collectionId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["paper-state", paper.paper_canonical_key] });
    },
  });

  const addTagMutation = useMutation({
    mutationFn: async (tag: string) => {
      await api.post(`/papers/${encodeURIComponent(paper.paper_canonical_key)}/tags`, { tag });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["paper-tags", paper.paper_canonical_key] });
      setNewTag("");
    },
  });

  const removeTagMutation = useMutation({
    mutationFn: async (tag: string) => {
      await api.delete(`/papers/${encodeURIComponent(paper.paper_canonical_key)}/tags/${encodeURIComponent(tag)}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["paper-tags", paper.paper_canonical_key] });
    },
  });

  const createNoteMutation = useMutation({
    mutationFn: async () => {
      await api.post("/notes", {
        target_type: "paper",
        target_key: paper.paper_canonical_key,
        content: newNote,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes", "paper", paper.paper_canonical_key] });
      setNewNote("");
    },
  });

  const deleteNoteMutation = useMutation({
    mutationFn: async (noteId: string) => {
      await api.delete(`/notes/${noteId}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes", "paper", paper.paper_canonical_key] });
    },
  });

  const currentState = states?.find((s) => s.collection_id === collectionId)?.state ?? "unseen";

  return (
    <div className="cp-item card">
      <div className="cp-header">
        <span className="cp-key" title={paper.paper_canonical_key}>
          {paper.paper_canonical_key.length > 60
            ? paper.paper_canonical_key.slice(0, 60) + "…"
            : paper.paper_canonical_key}
        </span>
        <div className="cp-actions">
          <Link
            to={`/graph/${encodeURIComponent(paper.paper_canonical_key)}`}
            className="btn-ghost"
            title="Explore in graph"
          >
            <GitFork size={14} />
          </Link>
          <button className="btn-ghost" onClick={onRemove} title="Remove from collection">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="cp-controls">
        {/* Reading state */}
        <div className="state-selector">
          <span>State:</span>
          <select
            value={currentState}
            onChange={(e) => setStateMutation.mutate(e.target.value)}
          >
            {READING_STATES.map((s) => (
              <option key={s} value={s}>{s.replace("_", " ")}</option>
            ))}
          </select>
        </div>

        {/* Tags */}
        <div className="paper-tags">
          {tags?.map((t) => (
            <span key={t.tag} className="paper-tag">
              {t.tag}
              <button onClick={() => removeTagMutation.mutate(t.tag)} title="Remove tag">
                <X size={10} />
              </button>
            </span>
          ))}
          <form
            className="tag-add-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (newTag.trim()) addTagMutation.mutate(newTag.trim());
            }}
          >
            <input
              placeholder="+ tag"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
            />
          </form>
        </div>
      </div>

      {/* Notes toggle */}
      <div className="cp-notes-toggle">
        <button className="btn-ghost" onClick={() => setShowNotes((s) => !s)}>
          <StickyNote size={12} />
          Notes
          {showNotes ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {showNotes && (
        <div className="cp-notes">
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (newNote.trim()) createNoteMutation.mutate();
            }}
            className="note-form-inline"
          >
            <input
              className="input"
              placeholder="Write a note…"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={!newNote.trim()}>
              Add
            </button>
          </form>
          {notes?.map((note) => (
            <div key={note.id} className="note-inline">
              <p>{note.content}</p>
              <button className="btn-ghost" onClick={() => deleteNoteMutation.mutate(note.id)}>
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      <span className="cp-added">Added {new Date(paper.added_at).toLocaleDateString()}</span>
    </div>
  );
}
