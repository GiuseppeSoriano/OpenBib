import { useId, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import DialogSurface from "@/components/ui/DialogSurface";

interface PanelProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Extra ids appended to the accessible name after the title. */
  labelledBy?: string;
  /** "auto": right sheet ≥768px, bottom sheet below; "bottom": always a bottom sheet. */
  placement?: "auto" | "bottom";
  returnFocusRef?: RefObject<HTMLElement>;
  initialFocusRef?: RefObject<HTMLElement>;
  fallbackFocus?: () => HTMLElement | null | undefined;
  testId?: string;
  children: ReactNode;
}

/**
 * Overlay detail panel: right sheet on desktop (≥768px), bottom sheet
 * with a grab handle on phones. Escape and overlay-click close it.
 */
export default function Panel({
  open,
  onClose,
  title,
  labelledBy,
  placement = "auto",
  returnFocusRef,
  initialFocusRef,
  fallbackFocus,
  testId,
  children,
}: PanelProps) {
  const { t } = useTranslation();
  const titleId = useId();

  if (!open) return null;

  const nameIds = [title != null ? titleId : null, labelledBy].filter(Boolean).join(" ");

  return (
    <DialogSurface
      onClose={onClose}
      labelledBy={nameIds}
      initialFocusRef={initialFocusRef}
      returnFocusRef={returnFocusRef}
      fallbackFocus={fallbackFocus}
      overlayClassName="panel-overlay"
      className={placement === "bottom" ? "panel panel--bottom" : "panel"}
      as="aside"
      testId={testId}
    >
      <div className="panel-handle" aria-hidden="true" />
      <div className="panel-header">
        <h2 id={titleId} className="panel-title">
          {title}
        </h2>
        <button type="button" className="btn-ghost" onClick={onClose} aria-label={t("common.close")}>
          <X size={18} />
        </button>
      </div>
      <div className="panel-body">{children}</div>
    </DialogSurface>
  );
}
