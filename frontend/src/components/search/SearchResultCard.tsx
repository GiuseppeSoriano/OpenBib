import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookMarked, Check, EyeOff, FolderCheck, MoreHorizontal, Quote, Share2, Undo2 } from "lucide-react";
import api, { library } from "@/lib/api";
import { copyText, formatCitation } from "@/lib/citation";
import { useAuth } from "@/contexts/AuthContext";
import PaperCard from "@/components/paper/PaperCard";
import AddToCollectionMenu from "@/components/paper/AddToCollectionMenu";
import Menu from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import type { PaperMetadata } from "@/types";

interface SearchResultCardProps {
  paper: PaperMetadata;
  providerSources: string[];
  savedInCollections: string[];
  isDismissed: boolean;
  inLibrary: boolean;
  onOpenDetails: (key: string) => void;
  /** A note under the meta line (a possible other version). */
  note?: ReactNode;
  /** Version picker for grouped results, rendered inside the card. */
  children?: ReactNode;
  /** Phones: Cite, Citation graph and Not relevant fold into a More menu. */
  compact?: boolean;
}

/**
 * A search result row: the shared PaperCard (row variant) with quiet
 * actions: Save, Add to collection, Cite, Citation graph, Not relevant.
 */
export default function SearchResultCard({
  paper,
  providerSources,
  savedInCollections,
  isDismissed,
  inLibrary,
  onOpenDetails,
  note,
  children,
  compact = false,
}: SearchResultCardProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { toast } = useToast();
  const moreRef = useRef<HTMLDivElement>(null);
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

  /** Copies an APA-style reference; the toast region announces the outcome. */
  const cite = async () => {
    const copied = await copyText(formatCitation(paper));
    toast(t(copied ? "paper.cite.copied" : "paper.cite.failed"), copied ? "success" : "error");
  };

  const graphPath = `/graph/${encodeURIComponent(paper.canonical_key)}`;
  const dismissing = isDismissed ? undismissMutation : dismissMutation;
  const dismissLabel = isDismissed ? t("paper.undoDismiss") : t("paper.notRelevant");
  const DismissIcon = isDismissed ? Undo2 : EyeOff;
  const toggleDismissed = () => {
    if (!dismissing.isPending) dismissing.mutate();
  };

  // Stays focusable once saved (aria-disabled), so focus is not lost.
  const saveButton = inLibraryNow ? (
    <button
      type="button"
      className="btn-quiet btn-quiet--accent"
      aria-disabled="true"
      title={t("paper.alreadyInLibrary")}
    >
      <Check size={14} aria-hidden="true" />
      {t("paper.inLibrary")}
    </button>
  ) : (
    <button
      type="button"
      className="btn-quiet"
      aria-disabled={saveToLibraryMutation.isPending || undefined}
      title={t("paper.saveToLibraryTitle")}
      onClick={() => {
        if (!saveToLibraryMutation.isPending) saveToLibraryMutation.mutate();
      }}
    >
      <BookMarked size={14} aria-hidden="true" />
      {t("search.save")}
    </button>
  );

  // A More menu item closes the menu; focus goes back to its trigger.
  const fromMenu = (close: () => void, action: () => void) => () => {
    close();
    moreRef.current?.querySelector<HTMLElement>("button[aria-haspopup]")?.focus();
    action();
  };

  const actions =
    compact && user ? (
      <>
        {saveButton}
        <AddToCollectionMenu
          variant="quiet"
          canonicalKey={paper.canonical_key}
          savedInCollections={savedInCollections}
        />
        <div ref={moreRef} className="paper-actions-end">
          <Menu
            align="right"
            button={<MoreHorizontal size={18} aria-hidden="true" />}
            buttonClassName="btn-quiet"
            buttonAriaLabel={t("search.moreActions")}
            buttonTitle={t("search.moreActions")}
          >
            {(close) => (
              <>
                <button type="button" role="menuitem" className="menu-item" onClick={fromMenu(close, () => void cite())}>
                  <Quote size={15} aria-hidden="true" />
                  {t("paper.cite.action")}
                </button>
                <Link to={graphPath} role="menuitem" className="menu-item" onClick={close}>
                  <Share2 size={15} aria-hidden="true" />
                  {t("search.citationGraph")}
                </Link>
                <button type="button" role="menuitem" className="menu-item" onClick={fromMenu(close, toggleDismissed)}>
                  <DismissIcon size={15} aria-hidden="true" />
                  {dismissLabel}
                </button>
              </>
            )}
          </Menu>
        </div>
      </>
    ) : (
      <>
        {user && (
          <>
            {saveButton}
            <AddToCollectionMenu
              variant="quiet"
              canonicalKey={paper.canonical_key}
              savedInCollections={savedInCollections}
            />
          </>
        )}
        <button type="button" className="btn-quiet" title={t("paper.cite.title")} onClick={() => void cite()}>
          <Quote size={14} aria-hidden="true" />
          {t("paper.cite.action")}
        </button>
        {/* Share2: the same icon as the sidebar's Citation graph item. */}
        <Link to={graphPath} className="btn-quiet">
          <Share2 size={14} aria-hidden="true" />
          {t("search.citationGraph")}
        </Link>
        {user && (
          <button
            type="button"
            className="btn-quiet btn-quiet--muted paper-actions-end"
            aria-disabled={dismissing.isPending || undefined}
            title={isDismissed ? t("paper.undoDismiss") : t("paper.notRelevantTitle")}
            onClick={toggleDismissed}
          >
            <DismissIcon size={14} aria-hidden="true" />
            {dismissLabel}
          </button>
        )}
      </>
    );

  return (
    <PaperCard
      variant="row"
      paper={paper}
      providerSources={providerSources}
      onOpenDetails={() => onOpenDetails(paper.canonical_key)}
      className={isDismissed ? "paper-card--dismissed" : ""}
      note={note}
      headerBadges={
        <>
          {/* Collections, not the Library: the "In Library" action already says that. */}
          {isSaved && (
            <span className="badge">
              <FolderCheck size={13} aria-hidden="true" />
              {t("paper.inCollections", { count: savedInCollections.length })}
            </span>
          )}
          {isDismissed && <span className="badge badge--neutral">{t("paper.dismissed")}</span>}
        </>
      }
      actions={actions}
    >
      {children}
    </PaperCard>
  );
}
