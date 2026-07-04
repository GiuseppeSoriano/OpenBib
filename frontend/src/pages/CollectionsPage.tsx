import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import type { Collection, Visibility } from "@/types";
import { Plus, Trash2, FolderOpen } from "lucide-react";
import ConfirmModal from "@/components/ConfirmModal";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import "./CollectionsPage.css";

export default function CollectionsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [pendingDelete, setPendingDelete] = useState<Collection | null>(null);

  const { data: collections, isLoading } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data } = await api.get<Collection[]>("/collections");
      return data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      await api.post("/collections", { name, description: description || null, visibility });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      setShowForm(false);
      setName("");
      setDescription("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/collections/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      void queryClient.invalidateQueries({ queryKey: ["user-stats"] });
      void queryClient.invalidateQueries({ queryKey: ["paper-memberships"] });
    },
  });

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) createMutation.mutate();
  };

  return (
    <div className="collections-page">
      <div className="page-header">
        <h1>{t("collections.title")}</h1>
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
          <Plus size={16} />
          {t("collections.new")}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="card create-form">
          <input
            className="input"
            placeholder={t("collections.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
          <input
            className="input"
            placeholder={t("collections.descriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <select
            className="input"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Visibility)}
          >
            <option value="private">{t("collections.visibilityPrivate")}</option>
            <option value="shared">{t("collections.visibilityShared")}</option>
            <option value="public">{t("collections.visibilityPublic")}</option>
          </select>
          <div className="create-form-actions">
            <button type="submit" className="btn btn-primary">
              {t("collections.create")}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowForm(false)}
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}

      {isLoading && <SkeletonCard count={3} />}

      <div className="collection-grid">
        {collections?.map((c) => (
          <div key={c.id} className="card collection-item">
            <Link to={`/collections/${c.id}`} className="collection-link">
              <h3>{c.name}</h3>
              {c.description && <p>{c.description}</p>}
              <div className="collection-item-meta">
                <span className="badge">
                  {t(`collections.visibility${c.visibility.charAt(0).toUpperCase()}${c.visibility.slice(1)}`)}
                </span>
                <span>{t("collections.paperCount", { count: c.paper_count })}</span>
              </div>
            </Link>
            <button
              className="btn-ghost delete-btn"
              onClick={() => setPendingDelete(c)}
              title={t("collections.deleteCollectionTitle")}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      {collections && collections.length === 0 && (
        <EmptyState
          icon={FolderOpen}
          title={t("collections.emptyTitle")}
          description={t("collections.emptyDescription")}
          action={
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>
              <Plus size={16} />
              {t("collections.new")}
            </button>
          }
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title={t("collections.deleteTitle", { name: pendingDelete.name })}
          message={t("collections.deleteMessage", { count: pendingDelete.paper_count })}
          confirmLabel={t("collections.deleteConfirm")}
          onConfirm={() => {
            deleteMutation.mutate(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
