import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle, GitFork, Loader2, Lock, RotateCcw } from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";
import { apiStatus, retryAfterSeconds } from "@/lib/apiError";

type GraphBaseStateProps =
  | { status: "loading" }
  | { status: "empty"; description: string }
  | { status: "unavailable"; backTo: string }
  | { status: "error"; error: unknown; retrying?: boolean; onRetry: () => void };

/** Status-specific copy for a failed base graph. */
export function baseErrorMessage(error: unknown, t: TFunction): string {
  const status = apiStatus(error);
  if (status === 422) return t("graph.tooManySeeds");
  if (status === 429) return t("graph.rateLimited", { seconds: retryAfterSeconds(error) ?? 60 });
  if (status === 403 || status === 404) return t("graph.notAvailable");
  return t("graph.baseFailed");
}

/**
 * The canvas area before a base graph is ready: loading, empty, a shared
 * collection that is no longer readable, or a specific error with Retry.
 * The page header stays rendered around it.
 */
export default function GraphBaseState(props: GraphBaseStateProps) {
  const { t } = useTranslation();

  if (props.status === "loading") {
    return (
      <div className="graph-base-state" role="status">
        <p className="graph-base-loading">
          <Loader2 size={18} className="spin" aria-hidden="true" /> {t("graph.loading")}
        </p>
      </div>
    );
  }

  if (props.status === "empty") {
    return (
      <div className="graph-base-state">
        <EmptyState icon={GitFork} title={t("graph.title")} description={props.description} />
      </div>
    );
  }

  if (props.status === "unavailable") {
    return (
      <div className="graph-base-state" role="alert">
        <EmptyState
          icon={Lock}
          title={t("sharing.unavailable")}
          action={
            <Link to={props.backTo} className="btn btn-secondary graph-btn">
              {t("graph.backToCollection")}
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="graph-base-state" role="alert">
      <EmptyState
        icon={AlertTriangle}
        title={baseErrorMessage(props.error, t)}
        action={
          <button type="button" className="btn btn-secondary graph-btn" onClick={props.onRetry} disabled={props.retrying}>
            <RotateCcw size={14} aria-hidden="true" />
            {props.retrying ? t("common.retrying") : t("common.retry")}
          </button>
        }
      />
    </div>
  );
}
