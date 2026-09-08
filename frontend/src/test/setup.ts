import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { testAuth, mockRefresh } from "./auth-mock";
import i18n from "@/i18n";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAuthFailureHandler: vi.fn(),
}));

// jsdom does not implement matchMedia; ThemeContext needs it.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// jsdom does not implement ResizeObserver; CitationGraph needs it.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = window.ResizeObserver ?? (ResizeObserverStub as typeof ResizeObserver);

// Node's native channel uses a different Event realm from jsdom. Keep browser-like
// delivery local to each test environment instead of broadcasting across test files.
class BroadcastChannelStub {
  static channels = new Set<BroadcastChannelStub>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(public name: string) { BroadcastChannelStub.channels.add(this); }
  postMessage(data: unknown) {
    for (const channel of BroadcastChannelStub.channels) {
      if (channel !== this && channel.name === this.name) queueMicrotask(() => channel.onmessage?.({ data } as MessageEvent));
    }
  }
  close() { this.onmessage = null; BroadcastChannelStub.channels.delete(this); }
}
vi.stubGlobal("BroadcastChannel", BroadcastChannelStub);

afterEach(async () => {
  cleanup();
  testAuth.authenticated = false;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  await i18n.changeLanguage("en");
});
