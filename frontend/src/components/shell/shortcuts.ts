import { useEffect, useRef } from "react";

/** True on Apple platforms, where the palette shortcut is ⌘K rather than Ctrl+K. */
function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** The palette shortcut as shown in kbd hints. */
export function shortcutLabel(): string {
  return isApple() ? "⌘K" : "Ctrl K";
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

/** The current page's own search field (Search, landing), if it has one. */
export function pageSearchField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    'main form[role="search"] input:not([type="hidden"]):not([disabled])',
  );
}

/**
 * ⌘K / Ctrl+K toggles the command palette; "/" focuses the page's search
 * field, or opens the palette on pages without one. Both stay quiet while
 * another dialog is open, and "/" while the user is typing.
 */
export function useShellShortcuts(paletteOpen: boolean, setPaletteOpen: (open: boolean) => void): void {
  const state = useRef({ paletteOpen, setPaletteOpen });
  state.current = { paletteOpen, setPaletteOpen };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const { paletteOpen: open, setPaletteOpen: setOpen } = state.current;
      const otherDialog = !open && document.querySelector("[data-overlay-layer]") !== null;
      const key = event.key.toLowerCase();

      if (key === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        if (otherDialog) return;
        event.preventDefault();
        setOpen(!open);
        return;
      }
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (open || otherDialog || isEditable(event.target)) return;
      event.preventDefault();
      const field = pageSearchField();
      if (field) {
        field.focus();
        field.select();
      } else {
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
