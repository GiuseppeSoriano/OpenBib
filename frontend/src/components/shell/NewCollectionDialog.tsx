import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import Modal from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import type { Collection } from "@/types";

/** "+" in the sidebar and the palette's New collection: create one, then open it. */
export default function NewCollectionDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: async () =>
      (await api.post<Collection>("/collections", { name: name.trim(), description: description.trim() || null })).data,
    onSuccess: (collection) => {
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      void queryClient.invalidateQueries({ queryKey: ["user-stats"] });
      onClose();
      if (collection?.id) navigate(`/collections/${collection.id}`);
    },
    onError: () => toast(t("collections.createFailed"), "error"),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !create.isPending) create.mutate();
  };

  return (
    <Modal open onClose={onClose} title={t("collections.new")}>
      <form onSubmit={submit} className="shell-form">
        <input
          className="input"
          aria-label={t("collections.namePlaceholder")}
          placeholder={t("collections.namePlaceholder")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          autoFocus
        />
        <input
          className="input"
          aria-label={t("collections.descriptionPlaceholder")}
          placeholder={t("collections.descriptionPlaceholder")}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <div className="confirm-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || create.isPending}>
            {t("collections.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
