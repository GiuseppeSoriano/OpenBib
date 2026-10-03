import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

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

// Space kept between an open menu and the viewport edges.
const VIEWPORT_GUTTER = 16;

/**
 * Horizontal offset (px) that moves a popover at `left`..`right` inside a
 * viewport `viewportWidth` wide, keeping the gutter where there is room.
 */
export function menuShift(left: number, right: number, viewportWidth: number): number {
  const gutter = Math.max(0, Math.min(VIEWPORT_GUTTER, (viewportWidth - (right - left)) / 2));
  let shift = 0;
  if (right > viewportWidth - gutter) shift = viewportWidth - gutter - right;
  if (left + shift < gutter) shift = gutter - left;
  return Math.round(shift);
}

/**
 * Minimal popover-menu primitive: click-outside + Escape to close,
 * focus returns to the trigger, ARIA menu semantics. The popover is at most
 * the viewport's width (CSS) and is nudged sideways to stay on screen.
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
  const popoverRef = useRef<HTMLDivElement>(null);

  // Anchored to its trigger, a popover near an edge can run off screen. The
  // offset goes through a custom property (CSSOM, allowed by the strict CSP)
  // and is measured again when the content (lazy items) or viewport changes.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!open || !el) return;
    const fit = () => {
      el.style.removeProperty("--menu-shift");
      const rect = el.getBoundingClientRect();
      const shift = menuShift(rect.left, rect.right, document.documentElement.clientWidth);
      if (shift) el.style.setProperty("--menu-shift", `${shift}px`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [open]);

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
        <div ref={popoverRef} className={`menu-popover menu-popover--${align}`} role="menu">
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
