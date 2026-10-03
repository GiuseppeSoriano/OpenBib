import { useLayoutEffect, useRef } from "react";

// Window scroll positions by page key. In memory only (never Web Storage) and
// cleared when the session ends.
const positions = new Map<string, number>();

// How long a restore keeps waiting for the page to grow tall enough.
const RESTORE_FRAMES = 60;
// Input that means the user is scrolling on their own.
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

export function clearScrollPositions(): void {
  positions.clear();
}

/**
 * Restores the window scroll position last recorded for `key` once the page
 * content is `ready`, then keeps recording it while the page stays mounted.
 *
 * Both run as layout effects. Leaving the page swaps in a shorter one, and the
 * browser clamps the scroll to it and fires `scroll` on its next frame; the
 * recorder is removed in the same commit, so that clamp never overwrites the
 * position (a passive cleanup can run after that frame under a transition).
 */
export function useScrollRestore(key: string, ready: boolean): void {
  const restoredKey = useRef<string | null>(null);
  // Set while a restore waits for the content to grow; scrolls meanwhile are ours.
  const pending = useRef(false);

  useLayoutEffect(() => {
    if (!ready || restoredKey.current === key) return;
    restoredKey.current = key;
    const y = positions.get(key);
    if (y === undefined) return;
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) <= 1) return;

    // Clamped: the rest of the page is still rendering. Retry for a moment,
    // and give up as soon as the user scrolls on their own.
    pending.current = true;
    let frames = 0;
    let frame = 0;
    const stop = () => {
      pending.current = false;
      cancelAnimationFrame(frame);
      for (const type of USER_SCROLL_EVENTS) window.removeEventListener(type, stop);
    };
    const retry = () => {
      window.scrollTo(0, y);
      frames += 1;
      if (Math.abs(window.scrollY - y) <= 1 || frames >= RESTORE_FRAMES) {
        stop();
        positions.set(key, window.scrollY);
      } else {
        frame = requestAnimationFrame(retry);
      }
    };
    for (const type of USER_SCROLL_EVENTS) window.addEventListener(type, stop, { passive: true });
    frame = requestAnimationFrame(retry);
    return () => {
      // Cleaned up mid-retry (e.g. StrictMode's effect replay, or `ready`
      // flipping): the restore did not finish, so a re-run starts it again.
      // A user scroll or a finished retry has already cleared `pending`.
      if (pending.current) restoredKey.current = null;
      stop();
    };
  }, [key, ready]);

  useLayoutEffect(() => {
    // Scrolls before the restore (e.g. the previous page's position) are not
    // this page's.
    const record = () => {
      if (restoredKey.current === key && !pending.current) positions.set(key, window.scrollY);
    };
    window.addEventListener("scroll", record, { passive: true });
    return () => window.removeEventListener("scroll", record);
  }, [key]);
}
