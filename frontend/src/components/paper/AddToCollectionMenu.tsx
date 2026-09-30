import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, FolderPlus } from "lucide-react";
import api from "@/lib/api";
import Menu from "@/components/ui/Menu";
import type { Collection } from "@/types";

interface AddToCollectionMenuProps {
  canonicalKey: string;
  /** Collection ids this paper is already saved in (from paper-memberships). */
  savedInCollections?: string[];
  /** "button" = labeled secondary button; "icon" = compact icon-only trigger. */
  variant?: "button" | "icon";
}

function editableOnly(collections: Collection[]): Collection[] {
  return collections.filter((collection) => collection.can_edit);
}

/**
 * Shared "Add to collection" popover — used on Search, Library, and the
 * paper details panel. Collections load lazily when the menu opens.
 */
export default function AddToCollectionMenu({
  canonicalKey,
  savedInCollections = [],
  variant = "button",
}: AddToCollectionMenuProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [sessionAdded, setSessionAdded] = useState<Set<string>>(new Set());

  const { data: collections } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => (await api.get<Collection[]>("/collections")).data,
    // The cached list is the full one other pages show; only offer editable collections here.
    select: editableOnly,
    enabled,
  });

  const addMutation = useMutation({
    mutationFn: async (collectionId: string) => {
      await api.post(`/collections/${collectionId}/papers`, {
        paper_canonical_key: canonicalKey,
      });
      return collectionId;
    },
    onSuccess: (collectionId) => {
      setSessionAdded((prev) => new Set(prev).add(collectionId));
      void queryClient.invalidateQueries({ queryKey: ["paper-memberships"] });
      void queryClient.invalidateQueries({ queryKey: ["library-keys"] });
      void queryClient.invalidateQueries({ queryKey: ["library-entries"] });
      void queryClient.invalidateQueries({ queryKey: ["collection-papers", collectionId] });
      void queryClient.invalidateQueries({ queryKey: ["collection", collectionId] });
    },
  });

  const alreadyIn = (collectionId: string) =>
    savedInCollections.includes(collectionId) || sessionAdded.has(collectionId);

  return (
    <Menu
      align="left"
      button={
        variant === "button" ? (
          <>
            <FolderPlus size={14} />
            {t("paper.addToCollection")}
          </>
        ) : (
          <FolderPlus size={15} />
        )
      }
      buttonClassName={variant === "button" ? "btn btn-secondary" : "btn-ghost"}
      buttonAriaLabel={t("paper.addToCollection")}
      buttonTitle={t("paper.addToCollection")}
      onOpen={() => setEnabled(true)}
      testId="add-to-collection"
    >
      {(close) =>
        !collections || collections.length === 0 ? (
          <div className="menu-empty">
            {t("paper.noCollectionsYet")}{" "}
            <Link to="/collections" onClick={close}>
              {t("paper.createOne")}
            </Link>
          </div>
        ) : (
          collections.map((collection) => {
            const saved = alreadyIn(collection.id);
            return (
              <button
                key={collection.id}
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={saved || addMutation.isPending}
                title={saved ? t("paper.alreadySaved") : collection.name}
                onClick={() => addMutation.mutate(collection.id)}
              >
                <span className="menu-item-check">{saved && <Check size={14} />}</span>
                <span className="menu-item-label">{collection.name}</span>
              </button>
            );
          })
        )
      }
    </Menu>
  );
}
