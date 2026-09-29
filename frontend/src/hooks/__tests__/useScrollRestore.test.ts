import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { clearScrollPositions, useScrollRestore } from "@/hooks/useScrollRestore";

function scrollWindowTo(y: number) {
  Object.defineProperty(window, "scrollY", { configurable: true, value: y });
  window.dispatchEvent(new Event("scroll"));
}

let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollTo = vi.fn();
  vi.stubGlobal("scrollTo", scrollTo);
});

afterEach(() => {
  clearScrollPositions();
  vi.unstubAllGlobals();
  scrollWindowTo(0);
});

describe("useScrollRestore", () => {
  it("restores the last position for the key once ready", () => {
    const first = renderHook(() => useScrollRestore("library?", true));
    scrollWindowTo(840);
    first.unmount();
    scrollWindowTo(0);

    const { rerender } = renderHook(({ ready }) => useScrollRestore("library?", ready), {
      initialProps: { ready: false },
    });
    expect(scrollTo).not.toHaveBeenCalled();

    rerender({ ready: true });
    expect(scrollTo).toHaveBeenCalledWith(0, 840);
  });

  it("keeps positions per key and ignores scrolls before the restore", () => {
    const view = renderHook(({ ready }) => useScrollRestore("library?q=a", ready), {
      initialProps: { ready: false },
    });
    scrollWindowTo(500);
    view.unmount();

    renderHook(() => useScrollRestore("library?q=a", true));
    renderHook(() => useScrollRestore("library?q=b", true));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("forgets every position when the session is cleared", () => {
    const first = renderHook(() => useScrollRestore("library?", true));
    scrollWindowTo(300);
    first.unmount();

    clearScrollPositions();
    renderHook(() => useScrollRestore("library?", true));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
