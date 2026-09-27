import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { COMPACT_QUERY, TOUCH_QUERY } from "@/lib/breakpoints";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

/** A controllable matchMedia: `set()` flips the result and notifies listeners. */
function mockMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  window.matchMedia = ((query: string) => {
    queries.push(query);
    return {
      get matches() {
        return matches;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  return {
    listeners,
    queries,
    set(next: boolean) {
      matches = next;
      listeners.forEach((listener) => listener());
    },
  };
}

describe("useMediaQuery", () => {
  it("returns the current match and follows changes", () => {
    const media = mockMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery(COMPACT_QUERY));
    expect(result.current).toBe(true);
    expect(media.queries).toContain(COMPACT_QUERY);

    act(() => media.set(false));
    expect(result.current).toBe(false);

    act(() => media.set(true));
    expect(result.current).toBe(true);
  });

  it("stops listening on unmount", () => {
    const media = mockMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery(TOUCH_QUERY));
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("is false where matchMedia is unavailable", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    const { result } = renderHook(() => useMediaQuery(COMPACT_QUERY));
    expect(result.current).toBe(false);
  });
});
