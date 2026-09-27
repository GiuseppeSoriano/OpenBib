import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

interface MenuProps {
  /** Trigger button content. */
  button: ReactNode;
  buttonClassName?: string;
  buttonAriaLabel?: string;
  buttonTitle?: string;
  align?: "left" | "right";
  /** Menu content; receives a close() callback when given as a function. */
  children: ReactNode | ((close: () => void) => ReactNode);
  onOpen?: () => void;
  testId?: string;
}

/**
 * Minimal popover-menu primitive: click-outside + Escape to close,
 * focus returns to the trigger, ARIA menu semantics.
 */
export default function Menu({
  button,
  buttonClassName,
  buttonAriaLabel,
  buttonTitle,
  align = "right",
  children,
  onOpen,
  testId,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    // Capture phase, so the menu sees Escape before an enclosing dialog does,
    // even when focus fell back to <body> (e.g. a clicked item got disabled).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Behind an open dialog the page is inert: that dialog owns Escape.
      if (rootRef.current?.closest("[inert]")) return;
      e.preventDefault();
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const close = () => setOpen(false);

  // Escape inside the menu closes only the menu, never an enclosing dialog
  // (DialogSurface ignores defaultPrevented keys).
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="menu-root" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={buttonRef}
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonAriaLabel}
        title={buttonTitle}
        data-testid={testId}
        onClick={() =>
          setOpen((o) => {
            const next = !o;
            if (next) onOpen?.();
            return next;
          })
        }
      >
        {button}
      </button>
      {open && (
        <div className={`menu-popover menu-popover--${align}`} role="menu">
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
