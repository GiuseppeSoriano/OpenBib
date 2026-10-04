import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check } from "lucide-react";
import { tabbableIn } from "@/components/ui/DialogSurface";
import { menuShift } from "@/components/ui/Menu";

/** Spread onto the trigger button (a MenuChip, a .btn…). */
export interface PopoverTriggerProps {
  ref: RefObject<HTMLButtonElement>;
  "aria-haspopup": "dialog" | "listbox";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
}

export interface PopoverProps {
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Accessible name of a dialog popover (or use labelledBy). */
  label?: string;
  labelledBy?: string;
  /** "dialog": the surface is a non-modal dialog. "listbox": the content
   *  supplies the role (PopoverListbox). */
  haspopup?: "dialog" | "listbox";
  align?: "start" | "end";
  /** Controlled open state; omit both for an uncontrolled popover. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Receives focus on open; defaults to the first tabbable element. */
  initialFocusRef?: RefObject<HTMLElement>;
  className?: string;
  testId?: string;
  /** Content; receives close(), which returns focus to the trigger. */
  children: ReactNode | ((close: () => void) => ReactNode);
}

/**
 * Non-modal popover anchored to its trigger: focus moves in on open,
 * Escape closes and returns focus to the trigger, an outside click or
 * tabbing away closes it in place. The trigger carries aria-expanded and
 * aria-controls; the surface stays inside the viewport (--popover-shift).
 */
export default function Popover({
  trigger,
  label,
  labelledBy,
  haspopup = "dialog",
  align = "start",
  open: openProp,
  onOpenChange,
  initialFocusRef,
  className,
  testId,
  children,
}: PopoverProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Latest onOpenChange, for the document listeners below.
  const onOpenChangeRef = useRef(onOpenChange);
  useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });

  const setOpenRef = useRef((next: boolean) => {
    setOpenState(next);
    onOpenChangeRef.current?.(next);
  });

  /** Closes; with returnFocus, focus inside the popover goes back to the trigger. */
  const closeRef = useRef((returnFocus: boolean) => {
    const active = document.activeElement;
    const focusInside =
      !active || active === document.body || !!surfaceRef.current?.contains(active);
    if (returnFocus && focusInside) triggerRef.current?.focus();
    setOpenRef.current(false);
  });

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!open || !surface) return;
    const target = initialFocusRef?.current ?? tabbableIn(surface)[0] ?? surface;
    target.focus({ preventScroll: true });
  }, [open, initialFocusRef]);

  // Same edge handling as ui/Menu, through its own custom property.
  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!open || !el) return;
    const fit = () => {
      el.style.removeProperty("--popover-shift");
      const rect = el.getBoundingClientRect();
      const shift = menuShift(rect.left, rect.right, document.documentElement.clientWidth);
      if (shift) el.style.setProperty("--popover-shift", `${shift}px`);
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
    const outside = (target: EventTarget | null) =>
      target instanceof Node && !!rootRef.current && !rootRef.current.contains(target);
    const onMouseDown = (event: MouseEvent) => {
      if (outside(event.target)) closeRef.current(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (outside(event.target)) closeRef.current(false);
    };
    // Capture phase, so the popover sees Escape before an enclosing dialog.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Behind an open dialog the page is inert: that dialog owns Escape.
      if (rootRef.current?.closest("[inert]")) {
        closeRef.current(false);
        return;
      }
      event.preventDefault();
      closeRef.current(true);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Escape inside the popover never reaches an enclosing dialog.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (open && event.key === "Escape") event.stopPropagation();
  };

  const surfaceId = `${id}-popover`;
  const classes = ["popover", `popover--${align}`, className].filter(Boolean).join(" ");

  return (
    <div className="popover-root" ref={rootRef} onKeyDown={onKeyDown}>
      {trigger({
        ref: triggerRef,
        "aria-haspopup": haspopup,
        "aria-expanded": open,
        "aria-controls": open ? surfaceId : undefined,
        onClick: () => setOpenRef.current(!open),
      })}
      {open && (
        <div
          ref={surfaceRef}
          id={surfaceId}
          className={classes}
          role={haspopup === "dialog" ? "dialog" : undefined}
          aria-label={haspopup === "dialog" ? label : undefined}
          aria-labelledby={haspopup === "dialog" ? labelledBy : undefined}
          tabIndex={-1}
          data-testid={testId}
        >
          {typeof children === "function" ? children(() => closeRef.current(true)) : children}
        </div>
      )}
    </div>
  );
}

export interface ListboxOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface PopoverListboxProps<T extends string> {
  /** Accessible name of the listbox (e.g. "Sort by"). */
  label: string;
  options: ListboxOption<T>[];
  value: T;
  /** Called with the chosen value; close the popover from here. */
  onSelect: (value: T) => void;
  testId?: string;
}

/**
 * Single-select listbox for a haspopup="listbox" Popover: the selected
 * option takes focus on open, arrows/Home/End move, Enter or Space selects.
 */
export function PopoverListbox<T extends string>({
  label,
  options,
  value,
  onSelect,
  testId,
}: PopoverListboxProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === "ArrowDown") next = Math.min(items.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if ((event.key === "Enter" || event.key === " ") && current !== -1) {
      event.preventDefault();
      onSelect(options[current]!.value);
      return;
    }
    if (next === -1) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      className="popover-listbox"
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <div
            key={option.value}
            role="option"
            aria-selected={selected}
            tabIndex={index === selectedIndex ? 0 : -1}
            className="popover-option"
            onClick={() => onSelect(option.value)}
          >
            {option.label}
            {selected && (
              <span className="popover-option-check" aria-hidden="true">
                <Check size={14} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
