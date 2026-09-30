import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import type { Collection } from "@/types";
import { Plus, Trash2, FolderOpen } from "lucide-react";
import QueryError from "@/components/ui/QueryError";
import { useToast } from "@/components/ui/Toast";
import ConfirmModal from "@/components/ConfirmModal";
import Modal from "@/components/ui/Modal";
import { SkeletonCard } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import "./CollectionsPage.css";

export default function CollectionsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Collection | null>(null);

  const { data: collections, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data } = await api.get<Collection[]>("/collections");
      return data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      await api.post("/collections", { name, description: description || null });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      setShowCreate(false);
      setName("");
      setDescription("");
    },
    onError: () => toast(t("collections.createFailed"), "error"),
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
    onError: () => toast(t("collections.deleteFailed"), "error"),
  });

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) createMutation.mutate();
  };

  return (
    <div className="collections-page">
      <div className="page-header">
        <h1>{t("collections.title")}</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={15} />
          {t("collections.new")}
        </button>
      </div>

      {isLoading && <SkeletonCard count={3} />}
      {isError && <QueryError onRetry={() => void refetch()} busy={isFetching} />}

      <div className="collection-grid">
        {collections?.map((c) => (
          <div key={c.id} className="card collection-item">
            <Link to={`/collections/${c.id}`} className="collection-link">
              <h3>{c.name}</h3>
              {c.description && <p>{c.description}</p>}
              <div className="collection-item-meta">
                <span className="badge badge--neutral">{t(c.is_owner ? "sharing.owner" : c.can_edit ? "sharing.editor" : "sharing.reader")}</span>
                <span>{t("collections.paperCount", { count: c.paper_count })}</span>
              </div>
            </Link>
            {c.is_owner && <button
              className="btn-ghost collection-delete"
              onClick={() => setPendingDelete(c)}
              title={t("collections.deleteCollectionTitle")}
            >
              <Trash2 size={14} />
            </button>}
          </div>
        ))}
      </div>

      {collections && collections.length === 0 && (
        <EmptyState
          icon={FolderOpen}
          title={t("collections.emptyTitle")}
          description={t("collections.emptyDescription")}
          action={
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
              <Plus size={15} />
              {t("collections.new")}
            </button>
          }
        />
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={t("collections.new")}>
        <form onSubmit={handleCreate} className="collection-create-form">
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
          <div className="confirm-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowCreate(false)}
            >
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim() || createMutation.isPending}>
              {t("collections.create")}
            </button>
          </div>
        </form>
      </Modal>

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
