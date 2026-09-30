import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import { apiStatus } from "@/lib/apiError";
import { parseIdentifierList, type IdentifierLine } from "@/lib/identifiers";
import { useApiErrorText } from "@/hooks/useApiErrorText";
import { useToast } from "@/components/ui/Toast";
import Modal from "@/components/ui/Modal";
import AnnouncedText from "@/components/ui/AnnouncedText";
import type { ImportLineStatus, ImportResult } from "@/types";
import "./CollectionPaperForms.css";

/** Lines per request: small enough for a progress bar and the provider budget. */
export const IMPORT_CHUNK_SIZE = 25;
/** Most distinct identifiers one paste may import. */
export const IMPORT_MAX = 500;

/** `failed`: the line was never answered (request error or stopped import). */
type LineStatus = ImportLineStatus | "failed";

interface LineResult {
  line: number;
  input: string;
  status: LineStatus;
  title: string | null;
}

interface ResultRow extends LineResult {
  /** For a repeated line: the line it repeats. */
  firstLine?: number;
}

const RETRYABLE: ReadonlySet<LineStatus> = new Set(["unavailable", "failed"]);
const FAILED: ReadonlySet<LineStatus> = new Set(["invalid", "not_found", "unavailable", "failed"]);
const TONE: Record<LineStatus, "ok" | "warn" | "error"> = {
  added: "ok",
  duplicate: "ok",
  unresolved: "warn",
  invalid: "error",
  not_found: "error",
  unavailable: "warn",
  failed: "warn",
};

interface ImportIdentifiersModalProps {
  collectionId: string;
  onClose: () => void;
  /** A 403/404: the import stops and the page re-checks access. */
  onAccessError: () => void;
}

/**
 * Bulk import: validates every line as it is typed, sends the distinct valid
 * identifiers in chunks with progress, and keeps a per-line report open until
 * Done. Lines the provider could not answer can be retried.
 */
export default function ImportIdentifiersModal({
  collectionId,
  onClose,
  onAccessError,
}: ImportIdentifiersModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const textareaId = `${id}-text`;
  const hintId = `${id}-hint`;
  const summaryId = `${id}-summary`;
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const cancelled = useRef(false);

  const [text, setText] = useState("");
  const parsed = useMemo(() => parseIdentifierList(text), [text]);
  const [phase, setPhase] = useState<"edit" | "running" | "done">("edit");
  const [results, setResults] = useState<ReadonlyMap<number, LineResult>>(new Map());
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [stopped, setStopped] = useState(false);
  const [requestError, setRequestError] = useState<unknown>(null);
  const {
    text: requestErrorText,
    announcement: requestErrorAnnouncement,
    waiting,
  } = useApiErrorText(requestError, t("errors.generic"));

  const count = parsed.valid.length;
  const tooMany = count > IMPORT_MAX;
  const retryTargets = parsed.valid.filter((entry) => {
    const status = results.get(entry.line)?.status;
    return status !== undefined && RETRYABLE.has(status);
  });

  useEffect(() => {
    if (phase === "done") resultsHeading.current?.focus();
  }, [phase]);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  async function run(targets: IdentifierLine[]) {
    cancelled.current = false;
    setPhase("running");
    setStopped(false);
    setRequestError(null);
    setProgress({ done: 0, total: targets.length });
    const merged = new Map(results);
    const record = (entries: LineResult[]) => {
      for (const entry of entries) merged.set(entry.line, entry);
      setResults(new Map(merged));
    };
    const unanswered = (entries: IdentifierLine[]): LineResult[] =>
      entries.map(({ line, input }) => ({ line, input, status: "failed", title: null }));

    for (let start = 0; start < targets.length && !cancelled.current; start += IMPORT_CHUNK_SIZE) {
      const chunk = targets.slice(start, start + IMPORT_CHUNK_SIZE);
      try {
        const { data } = await api.post<ImportResult>(`/collections/${collectionId}/import/dois`, {
          dois: chunk.map((entry) => entry.input),
        });
        const byLine = new Map(data.results.map((result) => [result.line, result]));
        record(
          chunk.map(({ line, input }, index) => {
            const answer = byLine.get(index + 1);
            return { line, input, status: answer?.status ?? "failed", title: answer?.title ?? null };
          }),
        );
      } catch (err) {
        const status = apiStatus(err);
        if (status === 403 || status === 404) {
          // Keep what was imported so far; nothing more can be sent.
          record(unanswered(targets.slice(start)));
          setStopped(true);
          onAccessError();
          break;
        }
        setRequestError(err);
        if (status === 429) {
          record(unanswered(targets.slice(start)));
          break;
        }
        record(unanswered(chunk));
      }
      setProgress({ done: Math.min(start + chunk.length, targets.length), total: targets.length });
    }

    for (const queryKey of [
      ["collection-papers", collectionId],
      ["collection", collectionId],
      ["library-entries"],
      ["library-keys"],
      ["library-facets"],
      ["paper-memberships"],
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    if (cancelled.current) return;
    const statuses = Array.from(merged.values(), (entry) => entry.status);
    const tally = (wanted: LineStatus) => statuses.filter((status) => status === wanted).length;
    const failed = statuses.filter((status) => FAILED.has(status)).length + parsed.invalid.length;
    toast(
      t("collections.imported", {
        added: tally("added"),
        pending: tally("unresolved"),
        skipped: tally("duplicate"),
        failed,
      }),
      failed > 0 ? "info" : "success",
    );
    setPhase("done");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (count > 0 && !tooMany) void run(parsed.valid);
  }

  function close() {
    cancelled.current = true;
    onClose();
  }

  const rows: ResultRow[] = [
    ...parsed.valid.flatMap((entry) => {
      const result = results.get(entry.line);
      return result ? [result] : [];
    }),
    ...(phase === "edit"
      ? []
      : [
          ...parsed.invalid.map(({ line, value }): ResultRow => ({ line, input: value, status: "invalid", title: null })),
          ...parsed.duplicates.map(
            ({ line, value, firstLine }): ResultRow => ({ line, input: value, status: "duplicate", title: null, firstLine }),
          ),
        ]),
  ].sort((a, b) => a.line - b.line);

  const statusText = (row: ResultRow) =>
    row.firstLine !== undefined
      ? t("collections.importResult.repeated", { line: row.firstLine })
      : t(`collections.importResult.${row.status}`);

  return (
    <Modal open onClose={close} title={t("collections.importDois")}>
      {phase === "edit" ? (
        <form className="cd-import" onSubmit={submit}>
          <label htmlFor={textareaId} className="cd-import-label">
            {t("collections.importLabel")}
          </label>
          <textarea
            id={textareaId}
            className="input cd-import-text"
            placeholder={t("collections.importPlaceholder")}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={6}
            spellCheck={false}
            aria-describedby={`${hintId} ${summaryId}`}
            autoFocus
          />
          <p id={hintId} className="cd-import-hint">
            {t("collections.importHint", { max: IMPORT_MAX })}
          </p>
          <p id={summaryId} className="cd-import-summary" aria-live="polite">
            {t("collections.importSummary", {
              valid: parsed.valid.length + parsed.duplicates.length,
              invalid: parsed.invalid.length,
            })}
            {parsed.duplicates.length > 0 &&
              ` ${t("collections.importDuplicates", { count: parsed.duplicates.length })}`}
          </p>
          {tooMany && (
            <p className="cd-import-error" role="alert">
              {t("collections.importTooMany", { max: IMPORT_MAX })}
            </p>
          )}
          {parsed.invalid.length > 0 && (
            <section className="cd-import-invalid" aria-labelledby={`${id}-invalid`}>
              <h4 id={`${id}-invalid`}>{t("collections.importInvalidHeading")}</h4>
              {/* A scroll container: focusable so the keyboard can scroll it. */}
              <ul tabIndex={0} aria-labelledby={`${id}-invalid`}>
                {parsed.invalid.map(({ line, value }) => (
                  <li key={line}>{t("collections.importInvalidLine", { line, value })}</li>
                ))}
              </ul>
            </section>
          )}
          <div className="confirm-actions">
            <button type="button" className="btn btn-secondary" onClick={close}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={count === 0 || tooMany}>
              {t("collections.importButton", { count })}
            </button>
          </div>
        </form>
      ) : (
        <div className="cd-import">
          {phase === "running" && (
            <div className="cd-import-progress" role="status">
              <progress value={progress.done} max={progress.total} aria-hidden="true" />
              <span>{t("collections.importProgress", progress)}</span>
            </div>
          )}
          {phase === "done" && (
            <h4 ref={resultsHeading} tabIndex={-1} className="cd-import-results-heading">
              {t("collections.importResultsHeading")}
            </h4>
          )}
          {stopped && (
            <p className="cd-import-error" role="alert">
              {t("collections.importStopped")}
            </p>
          )}
          {requestErrorText && !stopped && (
            <p className="cd-import-error" role="alert">
              <AnnouncedText text={requestErrorText} announcement={requestErrorAnnouncement} />
            </p>
          )}
          {rows.length > 0 && (
            <ol className="cd-import-results" tabIndex={0} aria-label={t("collections.importResultsHeading")}>
              {rows.map((row) => (
                <li key={row.line} className={`cd-import-result cd-import-result--${TONE[row.status]}`}>
                  <span className="cd-import-line">{t("collections.importResultLine", { line: row.line })}</span>
                  <span className="cd-import-input">{row.input}</span>
                  <span className="cd-import-status">{statusText(row)}</span>
                  {row.title && <span className="cd-import-title">{row.title}</span>}
                </li>
              ))}
            </ol>
          )}
          {phase === "done" && (
            <div className="confirm-actions">
              {retryTargets.length > 0 && !stopped && (
                <button type="button" className="btn btn-secondary" onClick={() => void run(retryTargets)} disabled={waiting}>
                  {t("collections.importRetry", { count: retryTargets.length })}
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={close}>
                {t("common.done")}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
