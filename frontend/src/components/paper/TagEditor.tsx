import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { papers } from "@/lib/api";

/** Chip list + inline add form bound to the per-paper tag endpoints. */
export default function TagEditor({ paperKey }: { paperKey: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [newTag, setNewTag] = useState("");

  const { data: tags } = useQuery({
    queryKey: ["paper-tags", paperKey],
    queryFn: () => papers.getTags(paperKey),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["paper-tags", paperKey] });
    void queryClient.invalidateQueries({ queryKey: ["library-entries"] });
  };

  const addMutation = useMutation({
    mutationFn: (tag: string) => papers.addTag(paperKey, tag),
    onSuccess: () => {
      setNewTag("");
      invalidate();
    },
  });

  const removeMutation = useMutation({
    mutationFn: (tag: string) => papers.removeTag(paperKey, tag),
    onSuccess: invalidate,
  });

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    const tag = newTag.trim();
    if (tag) addMutation.mutate(tag);
  };

  return (
    <div className="tag-editor" data-testid="tag-editor">
      <div className="tag-editor-list">
        {tags?.map(({ tag }) => (
          <span key={tag} className="paper-tag">
            {tag}
            <button
              type="button"
              onClick={() => removeMutation.mutate(tag)}
              disabled={removeMutation.isPending}
              aria-label={`${t("common.delete")} ${tag}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <form onSubmit={handleAdd} className="tag-editor-form">
        <input
          className="input tag-editor-input"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          placeholder={t("paper.tagPlaceholder")}
          maxLength={100}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={!newTag.trim() || addMutation.isPending}
        >
          <Plus size={13} />
          {t("paper.addTag")}
        </button>
      </form>
    </div>
  );
}
