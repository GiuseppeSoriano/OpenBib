import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { isTopDialog, pushDialog } from "@/components/ui/dialogStack";

export interface DialogSurfaceProps {
  onClose: () => void;
  /** Space-separated ids of the element(s) naming the dialog. */
  labelledBy: string;
  describedBy?: string;
  /** Receives focus on open; defaults to the dialog itself. */
  initialFocusRef?: RefObject<HTMLElement>;
  /** Receives focus on close; defaults to the element focused before opening. */
  returnFocusRef?: RefObject<HTMLElement>;
  /** Used on close when the return target is gone (e.g. its card re-rendered). */
  fallbackFocus?: () => HTMLElement | null | undefined;
  closeOnOverlay?: boolean;
  overlayClassName: string;
  className: string;
  as?: "div" | "aside";
  testId?: string;
  children: ReactNode;
}

const TABBABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "iframe",
  '[contenteditable="true"]',
  "[tabindex]",
].join(",");

export function tabbableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest("[inert], [hidden]"),
  );
}

/**
 * The accessible modal layer behind Panel and Modal. Mount it only while
 * open: it portals to <body>, makes the rest of the page inert, keeps
 * keyboard focus inside, closes on Escape (top dialog only) and returns
 * focus to the opener on unmount.
 */
export default function DialogSurface({
  onClose,
  labelledBy,
  describedBy,
  initialFocusRef,
  returnFocusRef,
  fallbackFocus,
  closeOnOverlay = true,
  overlayClassName,
  className,
  as: Tag = "div",
  testId,
  children,
}: DialogSurfaceProps) {
  // Captured during the first render, before any child autoFocus runs.
  const [returnTarget] = useState(() => {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  const layerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const pointerDownOnOverlay = useRef(false);

  // Latest props for the once-per-open effects below.
  const propsRef = useRef({ onClose, initialFocusRef, returnFocusRef, fallbackFocus });
  useLayoutEffect(() => {
    propsRef.current = { onClose, initialFocusRef, returnFocusRef, fallbackFocus };
  });

  useLayoutEffect(() => pushDialog(layerRef.current!), []);

  useEffect(() => {
    const layer = layerRef.current!;
    const dialog = dialogRef.current!;
    if (!dialog.contains(document.activeElement)) {
      (propsRef.current.initialFocusRef?.current ?? dialog).focus({ preventScroll: true });
    }

    const onFocusIn = (event: FocusEvent) => {
      if (!isTopDialog(layer)) return;
      const target = event.target;
      if (!(target instanceof Node) || layer.contains(target)) return;
      if (target instanceof Element && target.closest("[data-live-layer]")) return;
      dialog.focus({ preventScroll: true });
    };
    // Escape while focus fell back to <body> (e.g. the focused button was
    // disabled); keys pressed inside the dialog are handled by onKeyDown.
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !isTopDialog(layer)) return;
      if (event.target instanceof Node && layer.contains(event.target)) return;
      event.preventDefault();
      propsRef.current.onClose();
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onDocumentKeyDown);

    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onDocumentKeyDown);
      // Still attached: a StrictMode effect replay, not a real close.
      if (dialog.isConnected) return;
      const { returnFocusRef: returnRef, fallbackFocus: fallback } = propsRef.current;
      const target = returnRef?.current ?? returnTarget;
      const next = target?.isConnected ? target : fallback?.();
      if (next?.isConnected) next.focus({ preventScroll: true });
    };
  }, [returnTarget]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const dialog = dialogRef.current;
    // React bubbles events from nested (portaled) dialogs; they handle their own keys.
    if (!dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) return;
    if (event.key === "Escape") {
      if (event.defaultPrevented || !isTopDialog(layerRef.current)) return;
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = tabbableIn(dialog);
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      data-overlay-layer=""
      className={overlayClassName}
      ref={layerRef}
      onPointerDown={(event) => {
        pointerDownOnOverlay.current = event.target === event.currentTarget;
      }}
      onMouseDown={(event) => {
        // Keep focus inside the dialog when the scrim itself is pressed.
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      onClick={(event) => {
        const startedOnOverlay = pointerDownOnOverlay.current;
        pointerDownOnOverlay.current = false;
        if (closeOnOverlay && startedOnOverlay && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <Tag
        ref={dialogRef as RefObject<HTMLDivElement>}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        {children}
      </Tag>
    </div>,
    document.body,
  );
}
