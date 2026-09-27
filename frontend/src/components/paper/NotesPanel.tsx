import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { notes } from "@/lib/api";

interface NotesPanelProps {
  /** Notes are anchored on the paper group; creation targets a version key. */
  paperKey: string;
  paperGroupKey: string;
}

export default function NotesPanel({ paperKey, paperGroupKey }: NotesPanelProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");

  const queryKey = ["notes", "paper-group", paperGroupKey] as const;

  const { data: noteList } = useQuery({
    queryKey,
    queryFn: () => notes.listForPaperGroup(paperGroupKey),
  });

  const createMutation = useMutation({
    mutationFn: () => notes.createForPaper(paperKey, content.trim()),
    onSuccess: () => {
      setContent("");
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (noteId: string) => notes.remove(noteId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey }),
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (content.trim()) createMutation.mutate();
  };

  return (
    <div className="notes-panel" data-testid="notes-panel">
      {noteList && noteList.length > 0 && (
        <ul className="notes-list">
          {noteList.map((note) => (
            <li key={note.id} className="note-item">
              <div className="note-content">{note.content}</div>
              <div className="note-footer">
                <span className="note-date">
                  {new Intl.DateTimeFormat(i18n.language).format(new Date(note.created_at))}
                </span>
                <button
                  type="button"
                  className="btn-ghost note-delete"
                  onClick={() => deleteMutation.mutate(note.id)}
                  disabled={deleteMutation.isPending}
                  aria-label={t("common.delete")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={handleSubmit} className="notes-form">
        <textarea
          className="input notes-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            // Keep an unsaved draft: Escape must not close the details panel.
            if (e.key === "Escape" && content.trim()) e.preventDefault();
          }}
          placeholder={t("paper.notePlaceholder")}
          rows={3}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={!content.trim() || createMutation.isPending}
        >
          {t("paper.addNote")}
        </button>
      </form>
    </div>
  );
}
