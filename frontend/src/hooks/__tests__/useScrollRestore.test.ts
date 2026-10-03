import { StrictMode, createElement, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook } from "@testing-library/react";
import { clearScrollPositions, useScrollRestore } from "@/hooks/useScrollRestore";

function scrollWindowTo(y: number) {
  Object.defineProperty(window, "scrollY", { configurable: true, value: y });
  window.dispatchEvent(new Event("scroll"));
}

let scrollTo: ReturnType<typeof vi.fn>;
// The page's scroll range: window.scrollTo clamps to it, as a browser does.
let maxScroll: number;
let frames: FrameRequestCallback[];

function runFrame() {
  const queued = frames;
  frames = [];
  for (const callback of queued) callback(0);
}

beforeEach(() => {
  maxScroll = 100_000;
  frames = [];
  scrollTo = vi.fn((_x: number, y: number) => scrollWindowTo(Math.min(y, maxScroll)));
  vi.stubGlobal("scrollTo", scrollTo);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
});

afterEach(() => {
  clearScrollPositions();
  vi.unstubAllGlobals();
  scrollWindowTo(0);
});

function Library() {
  useScrollRestore("library?", true);
  return null;
}

/** A page that is shorter than the Library: the browser clamps the scroll as it appears. */
function ShortPage() {
  useLayoutEffect(() => {
    scrollWindowTo(0);
  }, []);
  return null;
}

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

  it("keeps the position when the next page clamps the scroll in the same commit", () => {
    const view = render(createElement(Library));
    scrollWindowTo(6944);

    // Library -> graph: the clamp to 0 lands before any passive cleanup could run.
    view.rerender(createElement(ShortPage));
    expect(window.scrollY).toBe(0);

    view.rerender(createElement(Library));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 6944);
    expect(window.scrollY).toBe(6944);
  });

  it("retries a clamped restore until the page is tall enough", () => {
    const first = renderHook(() => useScrollRestore("library?", true));
    scrollWindowTo(5000);
    first.unmount();
    scrollWindowTo(0);

    maxScroll = 1200;
    const second = renderHook(() => useScrollRestore("library?", true));
    expect(window.scrollY).toBe(1200);

    runFrame();
    expect(window.scrollY).toBe(1200);
    maxScroll = 20_000;
    runFrame();
    expect(window.scrollY).toBe(5000);
    expect(frames).toHaveLength(0);

    // The clamped steps were never recorded as the page's position.
    second.unmount();
    renderHook(() => useScrollRestore("library?", true));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 5000);
  });

  it("keeps retrying a clamped restore under StrictMode's effect replay", () => {
    const first = renderHook(() => useScrollRestore("library?", true));
    scrollWindowTo(5000);
    first.unmount();
    scrollWindowTo(0);

    // StrictMode mounts, cleans up and re-runs the effect: the replay must
    // resume the retry rather than treat the key as already restored.
    maxScroll = 1200;
    renderHook(() => useScrollRestore("library?", true), { wrapper: StrictMode });
    expect(window.scrollY).toBe(1200);
    expect(frames).toHaveLength(1);

    maxScroll = 20_000;
    runFrame();
    expect(window.scrollY).toBe(5000);
    expect(frames).toHaveLength(0);
  });

  it("stops retrying once the user scrolls", () => {
    const first = renderHook(() => useScrollRestore("library?", true));
    scrollWindowTo(5000);
    first.unmount();

    maxScroll = 1200;
    const second = renderHook(() => useScrollRestore("library?", true));
    const calls = scrollTo.mock.calls.length;
    window.dispatchEvent(new Event("wheel"));
    maxScroll = 20_000;
    runFrame();
    expect(scrollTo.mock.calls.length).toBe(calls);

    // From here the user's own scrolls are recorded again.
    scrollWindowTo(300);
    second.unmount();
    renderHook(() => useScrollRestore("library?", true));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 300);
  });
});
