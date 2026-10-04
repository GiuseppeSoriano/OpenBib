import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ExternalLink, PencilLine, RotateCcw } from "lucide-react";
import { library } from "@/lib/api";
import { apiStatus } from "@/lib/apiError";
import { describeStoredKey, parseIdentifier, type StoredKeyView } from "@/lib/identifiers";
import { useApiErrorText } from "@/hooks/useApiErrorText";
import { useToast } from "@/components/ui/Toast";
import AnnouncedText from "@/components/ui/AnnouncedText";
import type { LibraryResolveResult } from "@/types";
import "./PaperCard.css";
import "./UnresolvedPaperCard.css";

interface UnresolvedPaperCardProps {
  /** The paper key exactly as stored. */
  canonicalKey: string;
  /** When the paper was added; dates an internal reference. */
  addedAt?: string | null;
  /** Retry, Fix identifier and `actions` are offered only to users who can edit. */
  canEdit: boolean;
  onOpenDetails?: () => void;
  /** Called once a retry or fix has been answered, whatever its status. */
  onResolved?: (result: LibraryResolveResult) => void;
  /** Handles a failed retry or fix first; return true when it did (lost access). */
  onResolveError?: (error: unknown) => boolean;
  /** Remove or Delete controls; `describedBy` is the identifier line's id. */
  actions?: (describedBy: string) => ReactNode;
}

// Query families that list or count papers; a resolve can re-key any of them.
const LIST_QUERIES = [
  ["collection-papers"],
  ["collection"],
  ["library-entries"],
  ["library-entry"],
  ["library-facets"],
  ["library-keys"],
  ["paper-memberships"],
];

/**
 * A stored paper whose details could not be retrieved (a pending DOI or a
 * legacy key). It shows what was stored, never an internal hash key, and
 * lets editors retry, correct the identifier or remove the paper.
 */
export default function UnresolvedPaperCard({
  canonicalKey,
  addedAt,
  canEdit,
  onOpenDetails,
  onResolved,
  onResolveError,
  actions,
}: UnresolvedPaperCardProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const titleId = `${id}-title`;
  const identifierId = `${id}-identifier`;
  const formId = `${id}-fix`;
  const inputId = `${id}-fix-input`;
  const fixErrorId = `${id}-fix-error`;
  const fixButton = useRef<HTMLButtonElement>(null);
  const view = describeStoredKey(canonicalKey);

  const [fixOpen, setFixOpen] = useState(false);
  const [fixValue, setFixValue] = useState(() => defaultFixValue(view));
  const [status, setStatus] = useState<string | null>(null);
  const [fixMessage, setFixMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [fixError, setFixError] = useState<unknown>(null);
  const errorText = useApiErrorText(error, t("paper.loadFailedHint"));
  const fixErrorText = useApiErrorText(fixError, t("paper.loadFailedHint"));
  const fixText = fixMessage ?? (fixErrorText.text || null);
  // A hash key with no details, or a key that is no identifier, can only be fixed.
  const canRetry = view.kind !== "hash" && view.kind !== "invalid";

  const invalidateLists = () => {
    for (const queryKey of LIST_QUERIES) void queryClient.invalidateQueries({ queryKey });
  };

  const resolve = useMutation({
    mutationFn: (replacement: string | null) =>
      library.resolve({ paper_canonical_key: canonicalKey, replacement }),
    onMutate: () => {
      setStatus(null);
      setError(null);
      setFixMessage(null);
      setFixError(null);
    },
    onSuccess: (result, replacement) => {
      if (result.status === "resolved") {
        toast(t("paper.resolvedToast", { title: result.paper?.title ?? t("collections.thisPaper") }), "success");
        setFixOpen(false);
        invalidateLists();
      } else if (result.status === "not_found") {
        if (replacement) setFixMessage(t("paper.resolveNotFound"));
        else setStatus(t("paper.resolveNotFound"));
      } else {
        setStatus(t("paper.stillUnresolved"));
        // A legacy key may still move to its normalized form.
        if (result.canonical_key !== result.previous_key) invalidateLists();
      }
      onResolved?.(result);
    },
    onError: (err, replacement) => {
      if (onResolveError?.(err)) return;
      if (replacement && apiStatus(err) === 422) setFixError(err);
      else setError(err);
    },
  });
  const retrying = resolve.isPending && resolve.variables === null;

  function submitFix(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = fixValue.trim();
    if (!parseIdentifier(value)) {
      setFixError(null);
      setFixMessage(t("errors.invalid_identifier"));
      return;
    }
    resolve.mutate(value);
  }

  function closeFix() {
    setFixOpen(false);
    setFixMessage(null);
    setFixError(null);
    fixButton.current?.focus();
  }

  return (
    <article className="paper-card unresolved-card" aria-labelledby={titleId}>
      <div className="paper-title-row">
        {onOpenDetails ? (
          <button
            type="button"
            id={titleId}
            className="paper-title paper-title-btn"
            onClick={onOpenDetails}
            aria-describedby={identifierId}
          >
            {t("paper.unresolvedTitle")}
          </button>
        ) : (
          <h3 id={titleId} className="paper-title">
            {t("paper.unresolvedTitle")}
          </h3>
        )}
        <span className="badge badge--warning">
          <AlertTriangle size={11} aria-hidden="true" />
          {t("paper.unresolvedBadge")}
        </span>
      </div>

      <p className="paper-identifier" id={identifierId}>
        <IdentifierText view={view} addedAt={addedAt} />
      </p>
      <p className="paper-meta unresolved-explanation">
        {canEdit ? t("paper.unresolvedExplanation") : t("paper.unresolvedExplanationReadOnly")}
      </p>
      {status && (
        <p className="paper-unresolved-status" role="status">
          {status}
        </p>
      )}
      {errorText.text && (
        <p className="paper-field-error" role="alert">
          <AnnouncedText text={errorText.text} announcement={errorText.announcement} />
        </p>
      )}

      {canEdit && fixOpen && (
        <form id={formId} className="paper-fix-form" onSubmit={submitFix} noValidate>
          <label htmlFor={inputId}>{t("paper.correctIdentifierLabel")}</label>
          <div className="paper-fix-row">
            <input
              id={inputId}
              className="input"
              value={fixValue}
              onChange={(event) => {
                setFixValue(event.target.value);
                setFixMessage(null);
                setFixError(null);
              }}
              aria-invalid={fixText ? true : undefined}
              aria-describedby={fixText ? fixErrorId : identifierId}
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <button type="submit" className="btn btn-primary" disabled={!fixValue.trim() || resolve.isPending}>
              {t("paper.applyFix")}
            </button>
            <button type="button" className="btn btn-secondary" onClick={closeFix}>
              {t("common.cancel")}
            </button>
          </div>
          {fixText && (
            <p id={fixErrorId} className="paper-field-error" role="alert">
              <AnnouncedText text={fixText} announcement={fixMessage ? null : fixErrorText.announcement} />
            </p>
          )}
        </form>
      )}

      {canEdit && (
        <div className="paper-actions unresolved-actions">
          {canRetry && (
            <button
              type="button"
              className="btn-quiet btn-quiet--accent"
              onClick={() => resolve.mutate(null)}
              disabled={resolve.isPending || errorText.waiting}
              aria-describedby={identifierId}
            >
              <RotateCcw size={14} aria-hidden="true" />
              {retrying ? t("common.retrying") : t("common.retry")}
            </button>
          )}
          <button
            ref={fixButton}
            type="button"
            className={canRetry ? "btn-quiet" : "btn-quiet btn-quiet--accent"}
            onClick={() => (fixOpen ? closeFix() : setFixOpen(true))}
            aria-expanded={fixOpen}
            aria-controls={fixOpen ? formId : undefined}
            aria-describedby={identifierId}
          >
            <PencilLine size={14} aria-hidden="true" />
            {t("paper.fixIdentifier")}
          </button>
          {actions?.(identifierId)}
        </div>
      )}
    </article>
  );
}

function defaultFixValue(view: StoredKeyView): string {
  if (view.kind === "doi" || view.kind === "invalid") return view.value;
  return "";
}

const IDENTIFIER_LABELS = {
  doi: "paper.identifierDoi",
  arxiv: "paper.identifierArxiv",
  pmid: "paper.identifierPubmed",
  pmcid: "paper.identifierPmc",
} as const;

function IdentifierText({ view, addedAt }: { view: StoredKeyView; addedAt?: string | null }) {
  const { t, i18n } = useTranslation();
  if (view.kind === "hash") {
    const added = addedAt ? new Date(addedAt) : null;
    if (!added || Number.isNaN(added.getTime())) return <>{t("paper.internalReferenceUndated")}</>;
    const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(added);
    return <>{t("paper.internalReference", { date })}</>;
  }
  if (view.kind === "invalid") return <>{t("paper.identifierPlain", { value: view.value })}</>;
  const link = (
    <a className="paper-identifier-link" href={view.url} target="_blank" rel="noopener noreferrer">
      {view.kind === "s2" ? t("paper.semanticScholarRecord") : view.value}
      <ExternalLink size={12} aria-hidden="true" />
      <span className="sr-only">{` ${t("common.opensInNewTab")}`}</span>
    </a>
  );
  if (view.kind === "s2") return link;
  return (
    <>
      {`${t(IDENTIFIER_LABELS[view.kind])} `}
      {link}
    </>
  );
}
