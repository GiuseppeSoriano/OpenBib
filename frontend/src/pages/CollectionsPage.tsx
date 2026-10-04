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
import RowSkeletons from "@/components/paper/RowSkeletons";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { PHONE_QUERY } from "@/lib/breakpoints";
import "./CollectionsPage.css";

export default function CollectionsPage() {
  const { t, i18n } = useTranslation();
  const phone = useMediaQuery(PHONE_QUERY);
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

  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? ""
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(date);
  };
  const accessLabel = (c: Collection) =>
    t(c.is_owner ? "sharing.owner" : c.can_edit ? "sharing.editor" : "sharing.reader");
  const deleteButton = (c: Collection) =>
    c.is_owner && (
      <button
        type="button"
        className="btn-quiet btn-quiet--muted collection-delete"
        onClick={() => setPendingDelete(c)}
        title={t("collections.deleteCollectionTitle")}
        aria-label={t("collections.deleteCollectionTitle")}
        aria-describedby={`collection-${c.id}`}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    );
  const list = collections ?? [];

  return (
    <div className="collections-page">
      <PageHeader
        title={t("collections.title")}
        titleId="collections-title"
        description={t("collections.subtitle")}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={15} aria-hidden="true" />
            {t("collections.new")}
          </button>
        }
      />

      {isLoading && <RowSkeletons count={3} />}
      {isError && <QueryError onRetry={() => void refetch()} busy={isFetching} />}

      {list.length > 0 && !phone && (
        <div className="data-table-wrap collections-table-wrap">
          <table className="data-table collections-table" aria-labelledby="collections-title">
            <thead>
              <tr>
                <th scope="col">{t("collections.columnName")}</th>
                <th scope="col" className="num">{t("collections.columnPapers")}</th>
                <th scope="col">{t("collections.columnAccess")}</th>
                <th scope="col" className="num">{t("collections.columnUpdated")}</th>
                <th scope="col">
                  <span className="sr-only">{t("collections.columnActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="collections-name">
                    <Link to={`/collections/${c.id}`} id={`collection-${c.id}`}>
                      {c.name}
                    </Link>
                    {c.description && <p className="collections-description">{c.description}</p>}
                  </td>
                  <td className="num">{c.paper_count}</td>
                  <td className="collections-access">{accessLabel(c)}</td>
                  <td className="num muted">{formatDate(c.updated_at)}</td>
                  <td className="collections-actions">{deleteButton(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.length > 0 && phone && (
        <ul className="list-rows list-rows--ruled collections-rows" aria-labelledby="collections-title">
          {list.map((c) => (
            <li key={c.id} className="list-row collections-row">
              <div className="collections-row-text">
                <Link to={`/collections/${c.id}`} id={`collection-${c.id}`} className="collections-row-name">
                  {c.name}
                </Link>
                {c.description && <p className="collections-description">{c.description}</p>}
                <p className="row-meta">
                  {[t("collections.paperCount", { count: c.paper_count }), accessLabel(c), formatDate(c.updated_at)]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {deleteButton(c)}
            </li>
          ))}
        </ul>
      )}

      {collections && collections.length === 0 && (
        <EmptyState
          icon={FolderOpen}
          title={t("collections.emptyTitle")}
          description={t("collections.emptyDescription")}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              <Plus size={15} aria-hidden="true" />
              {t("collections.new")}
            </button>
          }
        />
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={t("collections.new")}>
        <form onSubmit={handleCreate} className="collection-create-form">
          <label className="collection-field">
            {t("collections.namePlaceholder")}
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="collection-field">
            {t("collections.descriptionPlaceholder")}
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
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
