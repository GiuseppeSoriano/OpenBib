import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";

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

afterEach(async () => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  await i18n.changeLanguage("en");
});
