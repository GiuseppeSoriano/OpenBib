import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookMarked, EyeOff, GitFork, Undo2 } from "lucide-react";
import api, { library } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import PaperCard from "@/components/paper/PaperCard";
import AddToCollectionMenu from "@/components/paper/AddToCollectionMenu";
import type { PaperMetadata } from "@/types";

interface SearchResultCardProps {
  paper: PaperMetadata;
  providerSources: string[];
  savedInCollections: string[];
  isDismissed: boolean;
  inLibrary: boolean;
  onOpenDetails: (key: string) => void;
  /** Version picker for grouped results, rendered inside the card. */
  children?: ReactNode;
}

/** A search result: shared PaperCard + search-specific actions. */
export default function SearchResultCard({
  paper,
  providerSources,
  savedInCollections,
  isDismissed,
  inLibrary,
  onOpenDetails,
  children,
}: SearchResultCardProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [sessionLibrarySaved, setSessionLibrarySaved] = useState(false);

  useEffect(() => {
    setSessionLibrarySaved(false);
  }, [paper.paper_group_key]);

  const saveToLibraryMutation = useMutation({
    mutationFn: async () => {
      await library.ensureEntry({
        paper_group_key: paper.paper_group_key,
        paper_canonical_key: paper.canonical_key,
        source_provider: paper.provider_source,
      });
    },
    onSuccess: () => {
      setSessionLibrarySaved(true);
      void queryClient.invalidateQueries({ queryKey: ["library-keys"] });
      void queryClient.invalidateQueries({ queryKey: ["library-entries"] });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/papers/${encodeURIComponent(paper.canonical_key)}/dismiss`);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["dismissed-papers"] });
      const prev = queryClient.getQueryData<string[]>(["dismissed-papers"]);
      queryClient.setQueryData<string[]>(["dismissed-papers"], (old) => [
        ...(old ?? []),
        paper.canonical_key,
      ]);
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["dismissed-papers"], ctx.prev);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["dismissed-papers"] });
    },
  });

  const undismissMutation = useMutation({
    mutationFn: async () => {
      await api.delete(`/papers/${encodeURIComponent(paper.canonical_key)}/dismiss`);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["dismissed-papers"] });
      const prev = queryClient.getQueryData<string[]>(["dismissed-papers"]);
      queryClient.setQueryData<string[]>(["dismissed-papers"], (old) =>
        (old ?? []).filter((key) => key !== paper.canonical_key),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["dismissed-papers"], ctx.prev);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["dismissed-papers"] });
    },
  });

  const isSaved = savedInCollections.length > 0;
  const inLibraryNow = inLibrary || sessionLibrarySaved;

  return (
    <PaperCard
      paper={paper}
      providerSources={providerSources}
      onOpenDetails={() => onOpenDetails(paper.canonical_key)}
      className={isDismissed ? "paper-card--dismissed" : ""}
      headerBadges={
        <>
          {isSaved && (
            <span className="badge" title={t("paper.savedTitle")}>
              {t("paper.saved")}
            </span>
          )}
          {inLibraryNow && (
            <span className="badge badge--success" title={t("paper.inLibraryTitle")}>
              {t("paper.inLibrary")}
            </span>
          )}
          {isDismissed && (
            <span className="badge badge--neutral">{t("paper.dismissed")}</span>
          )}
        </>
      }
      actions={
        <>
          {user && (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => saveToLibraryMutation.mutate()}
                disabled={inLibraryNow || saveToLibraryMutation.isPending}
                title={inLibraryNow ? t("paper.alreadyInLibrary") : t("paper.saveToLibraryTitle")}
              >
                <BookMarked size={14} />
                {inLibraryNow ? t("paper.inLibrary") : t("paper.saveToLibrary")}
              </button>
              <AddToCollectionMenu
                canonicalKey={paper.canonical_key}
                savedInCollections={savedInCollections}
              />
            </>
          )}

          <Link
            to={`/graph/${encodeURIComponent(paper.canonical_key)}`}
            className="btn btn-secondary"
          >
            <GitFork size={14} />
            {t("paper.exploreGraph")}
          </Link>

          {user &&
            (isDismissed ? (
              <button
                type="button"
                className="btn-ghost dismiss-btn"
                onClick={() => undismissMutation.mutate()}
                disabled={undismissMutation.isPending}
                title={t("paper.undoDismiss")}
              >
                <Undo2 size={14} />
                {t("paper.undoDismiss")}
              </button>
            ) : (
              <button
                type="button"
                className="btn-ghost dismiss-btn"
                onClick={() => dismissMutation.mutate()}
                disabled={dismissMutation.isPending}
                title={t("paper.notRelevantTitle")}
              >
                <EyeOff size={14} />
                {t("paper.notRelevant")}
              </button>
            ))}
        </>
      }
    >
      {children}
    </PaperCard>
  );
}
