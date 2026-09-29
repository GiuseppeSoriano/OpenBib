import { useEffect, useRef } from "react";

// Window scroll positions by page key. In memory only (never Web Storage) and
// cleared when the session ends.
const positions = new Map<string, number>();

export function clearScrollPositions(): void {
  positions.clear();
}

/**
 * Restores the window scroll position last recorded for `key` once the page
 * content is `ready`, then keeps recording it while the page stays mounted.
 */
export function useScrollRestore(key: string, ready: boolean): void {
  const restoredKey = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || restoredKey.current === key) return;
    restoredKey.current = key;
    const y = positions.get(key);
    if (y !== undefined) window.scrollTo(0, y);
  }, [key, ready]);

  useEffect(() => {
    // Scrolls before the restore (e.g. the previous page's position) are not
    // this page's.
    const record = () => {
      if (restoredKey.current === key) positions.set(key, window.scrollY);
    };
    window.addEventListener("scroll", record, { passive: true });
    return () => window.removeEventListener("scroll", record);
  }, [key]);
}
