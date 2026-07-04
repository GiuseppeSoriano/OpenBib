import { useTranslation } from "react-i18next";
import Modal from "@/components/ui/Modal";

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const { t } = useTranslation();
  return (
    <Modal open onClose={onCancel} title={title}>
      <p className="confirm-message">{message}</p>
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {cancelLabel ?? t("common.cancel")}
        </button>
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          {confirmLabel ?? t("common.confirm")}
        </button>
      </div>
    </Modal>
  );
}
