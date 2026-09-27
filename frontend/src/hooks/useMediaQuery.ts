import { useCallback, useSyncExternalStore } from "react";

function mediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(query);
}

/** Live match state of a CSS media query; false where matchMedia is unavailable. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mediaQueryList(query);
      if (!list) return () => {};
      if (typeof list.addEventListener === "function") {
        list.addEventListener("change", onChange);
        return () => list.removeEventListener("change", onChange);
      }
      // Safari < 14 only has the deprecated listener API.
      list.addListener(onChange);
      return () => list.removeListener(onChange);
    },
    [query],
  );
  const getSnapshot = () => mediaQueryList(query)?.matches ?? false;
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
