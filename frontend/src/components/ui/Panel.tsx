import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

interface PanelProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}

/**
 * Overlay detail panel: right sheet on desktop (≥768px), bottom sheet
 * with a grab handle on phones. Escape and overlay-click close it.
 */
export default function Panel({ open, onClose, title, children }: PanelProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="panel-overlay" onClick={onClose}>
      <aside
        className="panel"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-handle" aria-hidden="true" />
        <div className="panel-header">
          <div className="panel-title">{title}</div>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="panel-body">{children}</div>
      </aside>
    </div>
  );
}
