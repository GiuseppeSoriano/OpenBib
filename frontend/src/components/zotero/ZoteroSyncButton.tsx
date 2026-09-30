import { useId } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookUp } from "lucide-react";
import { zotero } from "@/lib/api";
import { apiErrorText, apiStatus } from "@/lib/apiError";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/Toast";
import type { ZoteroSyncReport } from "@/types";
import "./ZoteroSyncButton.css";

interface ZoteroSyncButtonProps {
  /** Sync this collection; the whole Library when omitted. */
  collectionId?: string;
  /** Read-capability headers for a collection opened through a read link. */
  headers?: Record<string, string>;
}

/**
 * "Sync to Zotero" for any signed-in user. Without a Zotero connection it is
 * a link to the Settings section that sets one up, with a visible hint —
 * never a disabled button explained only by a tooltip.
 */
export default function ZoteroSyncButton({ collectionId, headers }: ZoteroSyncButtonProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const hintId = useId();

  const { data: status, isLoading } = useQuery({
    queryKey: ["zotero-status"],
    queryFn: () => zotero.getStatus(),
    enabled: !!user,
  });

  const sync = useMutation({
    mutationFn: () =>
      collectionId ? zotero.syncCollection(collectionId, headers) : zotero.syncLibrary(),
    onSuccess: (report: ZoteroSyncReport) => {
      toast(
        t("zotero.report", {
          created: report.items_created,
          updated: report.items_updated,
          skipped: report.items_skipped,
        }),
        report.failures.length > 0 ? "info" : "success",
      );
      if (report.failures.length > 0) {
        toast(t("zotero.reportFailures", { count: report.failures.length }), "error");
      }
    },
    onError: (err: unknown) => {
      if (apiStatus(err) === 409) {
        // The stored key is gone or was rejected: show the connect link again.
        toast(t("zotero.notConfigured"), "error");
        void queryClient.invalidateQueries({ queryKey: ["zotero-status"] });
        return;
      }
      toast(apiErrorText(err, t, t("zotero.failed")), "error");
    },
  });

  if (!user) return null;

  if (status && !status.connected) {
    return (
      <div className="zotero-connect">
        <Link to="/settings#zotero" className="btn btn-secondary" aria-describedby={hintId}>
          <BookUp size={14} aria-hidden="true" /> {t("zotero.connectToSync")}
        </Link>
        <p id={hintId} className="zotero-hint">
          {t("zotero.notConnectedHint")}
        </p>
      </div>
    );
  }

  const busy = isLoading || sync.isPending;
  return (
    <button
      type="button"
      className="btn btn-secondary"
      onClick={() => sync.mutate()}
      disabled={busy}
      aria-busy={busy || undefined}
    >
      <BookUp size={14} aria-hidden="true" /> {sync.isPending ? t("zotero.syncing") : t("zotero.sync")}
    </button>
  );
}
