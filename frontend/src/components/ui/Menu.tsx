import { useEffect, useRef, useState, type ReactNode } from "react";

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="menu-root" ref={rootRef}>
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
