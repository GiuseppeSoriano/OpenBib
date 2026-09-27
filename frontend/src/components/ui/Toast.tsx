import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastState {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastState | null>(null);

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = "info") => {
      const id = nextId.current++;
      setItems((prev) => [...prev, { id, type, message }]);
      window.setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Portaled next to dialogs and exempt from their inert background. */}
      {createPortal(
        <div className="toast-container" data-live-layer="" role="status" aria-live="polite">
          {items.map((item) => {
            const Icon = ICONS[item.type];
            return (
              <div key={item.id} className={`toast toast--${item.type}`}>
                <Icon size={16} className="toast-icon" />
                <span className="toast-message">{item.message}</span>
                <button
                  type="button"
                  className="toast-close"
                  onClick={() => dismiss(item.id)}
                  aria-label={t("common.dismiss")}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastState {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
