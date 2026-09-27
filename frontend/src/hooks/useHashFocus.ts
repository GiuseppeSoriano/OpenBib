import { useEffect, type RefObject } from "react";
import { useLocation } from "react-router-dom";

interface HashFocusOptions {
  /** Wait until the section's content has loaded (default true). */
  ready?: boolean;
  /** Element to focus instead of the section, e.g. its first input. */
  focus?: RefObject<HTMLElement>;
}

/**
 * Deep links such as `/settings#zotero`: when the URL hash names `id`,
 * scroll the section into view and move keyboard focus to it (or to
 * `opts.focus` when that element exists).
 */
export function useHashFocus(
  id: string,
  target: RefObject<HTMLElement>,
  opts: HashFocusOptions = {},
): void {
  const { hash, key } = useLocation();
  const ready = opts.ready !== false;
  const focusRef = opts.focus;

  useEffect(() => {
    if (!ready || hash !== `#${id}`) return;
    const frame = requestAnimationFrame(() => {
      const section = target.current;
      if (!section) return;
      section.scrollIntoView?.({ block: "start" });
      const element = focusRef?.current ?? section;
      if (element.tabIndex < 0 && !element.hasAttribute("tabindex")) {
        element.setAttribute("tabindex", "-1");
      }
      element.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, key, id, ready, target, focusRef]);
}
