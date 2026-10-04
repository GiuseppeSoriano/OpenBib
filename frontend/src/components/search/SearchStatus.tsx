import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { searchErrorText, useSecondsUntil } from "@/components/search/searchRetry";
import "./SearchStatus.css";

export type SearchStatusKind = "idle" | "loading" | "results" | "empty" | "error";

interface SearchStatusProps {
  kind: SearchStatusKind;
  /** Display name of the provider that answers searches. */
  provider: string;
  /** Results on screen. */
  shown?: number;
  /** The provider's own estimate of all matches. */
  total?: number | null;
  /** Paging stopped at the provider's result window. */
  windowCapped?: boolean;
  /** The active filters and sort, e.g. "2019–2023 · most cited first". */
  filters?: string | null;
  error?: unknown;
  /** Epoch ms until which Retry waits (a Retry-After). */
  retryAt?: number | null;
  retrying?: boolean;
  /** Omitted when trying again cannot help (a rejected request). */
  onRetry?: () => void;
}

/**
 * One live status line for Search (S03): which provider answered, how much
 * of its result set is on screen and with which filters, no matches, or why
 * the provider is unavailable. A Retry-After wait is counted down on Retry,
 * outside the live region, so it is not announced every second.
 */
export default function SearchStatus({
  kind,
  provider,
  shown = 0,
  total = null,
  windowCapped = false,
  filters = null,
  error,
  retryAt = null,
  retrying = false,
  onRetry,
}: SearchStatusProps) {
  const { t } = useTranslation();
  const wait = useSecondsUntil(kind === "error" ? retryAt : null);

  let text = "";
  if (kind === "loading") text = t("search.searching", { provider });
  else if (kind === "empty") text = t("search.statusNone", { provider });
  else if (kind === "error") text = searchErrorText(error, t, retryAt !== null);
  else if (kind === "results") {
    text =
      total !== null && total >= shown
        ? t("search.statusShowing", { provider, shown, total })
        : t("search.statusShown", { provider, shown, count: shown });
    if (filters) text += ` · ${filters}`;
  }

  return (
    <div className={`search-status${kind === "error" ? " search-status--error" : ""}`}>
      <p className="search-status-text" role="status" data-testid="search-status">
        {text}
        {kind === "results" && windowCapped && (
          <span className="search-status-note">{` ${t("search.windowCapped")}`}</span>
        )}
      </p>
      {kind === "error" && onRetry && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onRetry}
          disabled={retrying || wait > 0}
        >
          <RotateCcw size={14} aria-hidden="true" />
          {wait > 0
            ? t("search.retryCountdown", { seconds: wait })
            : t(retrying ? "common.retrying" : "common.retry")}
        </button>
      )}
    </div>
  );
}
