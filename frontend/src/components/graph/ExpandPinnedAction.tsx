import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Maximize } from "lucide-react";
import type { ExpandRun } from "@/components/graph/graphExploration";

interface ExpandPinnedActionProps {
  pinnedCount: number;
  run: ExpandRun | null;
  /** Papers each pinned paper is topped up to. */
  target: number;
  onExpand: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * "Expand pinned nodes": tops every pinned paper up to one range of related
 * papers without removing anything. Large runs ask first; a running one
 * shows progress and can be cancelled.
 */
export default function ExpandPinnedAction({
  pinnedCount,
  run,
  target,
  onExpand,
  onConfirm,
  onCancel,
}: ExpandPinnedActionProps) {
  const { t } = useTranslation();
  const hintId = useId();

  if (run?.phase === "confirm") {
    return (
      <div className="graph-expand" role="group" aria-labelledby={hintId}>
        <p id={hintId} className="graph-expand-text">
          {t("graph.expandConfirm", { sources: run.sourceIds.length, upTo: run.upTo })}
        </p>
        <div className="graph-expand-actions">
          <button type="button" className="btn btn-primary graph-btn" onClick={onConfirm}>
            {t("common.continue")}
          </button>
          <button type="button" className="btn btn-secondary graph-btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    );
  }

  if (run) {
    const total = run.sourceIds.length;
    const done = total - run.queue.length;
    return (
      <div className="graph-expand">
        <p className="graph-expand-text">
          {run.phase === "running" && <Loader2 size={14} className="spin" aria-hidden="true" />}
          {t("graph.expanding", { done, total })}
        </p>
        <progress className="graph-expand-progress" max={total} value={done} aria-label={t("graph.expandPinned")} />
        <button type="button" className="btn btn-secondary graph-btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    );
  }

  const disabled = pinnedCount === 0;
  return (
    <div className="graph-expand">
      <button
        type="button"
        className="btn btn-primary graph-btn"
        disabled={disabled}
        aria-describedby={hintId}
        onClick={onExpand}
      >
        <Maximize size={14} aria-hidden="true" />
        {t("graph.expandPinned")}
      </button>
      <p id={hintId} className="graph-hint">
        {disabled ? t("graph.expandPinnedDisabled") : t("graph.expandPinnedHint", { count: target })}
      </p>
    </div>
  );
}
