import { useId, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import DialogSurface from "@/components/ui/DialogSurface";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  initialFocusRef?: RefObject<HTMLElement>;
  returnFocusRef?: RefObject<HTMLElement>;
  children: ReactNode;
}

export default function Modal({
  open,
  onClose,
  title,
  initialFocusRef,
  returnFocusRef,
  children,
}: ModalProps) {
  const { t } = useTranslation();
  const titleId = useId();

  if (!open) return null;

  return (
    <DialogSurface
      onClose={onClose}
      labelledBy={titleId}
      initialFocusRef={initialFocusRef}
      returnFocusRef={returnFocusRef}
      overlayClassName="modal-overlay"
      className="modal card"
    >
      <div className="modal-header">
        <h3 id={titleId} className="modal-title">
          {title}
        </h3>
        <button
          type="button"
          className="btn-ghost modal-close"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </DialogSurface>
  );
}
